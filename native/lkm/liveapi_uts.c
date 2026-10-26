// SPDX-License-Identifier: GPL-2.0
/*
 * liveapi_uts —— 按槽位改写 UTS namespace 的 release / version。
 *
 * 为什么需要内核模块：uname(2) 返回的是 current->nsproxy->uts_ns->name，
 * 用户态没有任何系统调用能改其中的 release / version（sethostname 只能改
 * nodename 和 domainname）。/proc/version 同样读当前 uts_ns，所以改了
 * uts_ns 两个地方一起生效。
 *
 * 每个容器有自己的 UTS namespace（CONFIG_UTS_NS=y，docker 默认 clone），
 * 所以按 pid 找到目标 uts_ns 改写，只影响那个容器，20 个槽可以各不相同。
 *
 * 注意：/proc/sys/kernel/osrelease 走的是 sysctl 表里硬编码的 init_uts_ns，
 * 不受这里影响 —— 那条路径需要另行处理（见 docs）。
 *
 * 接口：
 *   echo "<pid> <release> <version>" > /proc/liveapi_uts
 *   cat /proc/liveapi_uts      # 读回最近一次改写结果
 */
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/proc_fs.h>
#include <linux/uaccess.h>
#include <linux/sched.h>
#include <linux/nsproxy.h>
#include <linux/pid.h>
#include <linux/utsname.h>
#include <linux/rcupdate.h>
#include <linux/slab.h>
#include <linux/string.h>

#define PROC_NAME "liveapi_uts"
#define SKYLINK_MAX 512

static struct proc_dir_entry *liveapi_proc;

/* 读：回显最近一次改写，便于用户态断言 */
static char last_result[SKYLINK_MAX];
static DEFINE_MUTEX(liveapi_lock);

static ssize_t liveapi_read(struct file *f, char __user *buf, size_t len, loff_t *off)
{
	size_t n;
	int ret;

	if (*off > 0)
		return 0;

	mutex_lock(&liveapi_lock);
	n = strnlen(last_result, sizeof(last_result));
	ret = n ? (int)n : 0;
	if (ret && copy_to_user(buf, last_result, n))
		ret = -EFAULT;
	mutex_unlock(&liveapi_lock);

	if (ret > 0)
		*off += ret;
	return ret;
}

/*
 * 写：解析 "<pid> <release> <version>"，改写该 pid 所属 UTS namespace。
 *
 * 用 find_task_by_vpid + get_task_struct 拿引用，再用 RCU 读 nsproxy。
 * nsproxy 本身是 RCU 保护的，不能直接持有裸指针跨过 rcu_read_unlock。
 */
static ssize_t liveapi_write(struct file *f, const char __user *buf, size_t len, loff_t *off)
{
	char *kbuf;
	char *p;
	char *cursor;   /* strsep 的游标，必须与临时变量 p 分开 */
	char *tok_pid, *tok_rel, *tok_ver;
	struct task_struct *task;
	struct uts_namespace *ns;
	long pid;
	int ret = 0;
	size_t n = len > SKYLINK_MAX - 1 ? SKYLINK_MAX - 1 : len;

	kbuf = kzalloc(SKYLINK_MAX, GFP_KERNEL);
	if (!kbuf)
		return -ENOMEM;

	if (copy_from_user(kbuf, buf, n)) {
		kfree(kbuf);
		return -EFAULT;
	}
	kbuf[n] = '\0';

	/* 去掉尾部换行。注意这里用了 p 做临时变量 ——
	 * 之后 strsep 必须用新的 cursor，不能复用 p：
	 * p 此时指向 '\n' 的位置（或 NULL），拿它当游标等于从字符串
	 * 中间开始切，第二段必然为空。第一版就栽在这，
	 * 表现是 dmesg 里 "parse fail pid=1 rel=0 ver=0"。 */
	p = strchr(kbuf, '\n');
	if (p)
		*p = '\0';
	cursor = kbuf;

	/* 解析格式：<pid> <release> <version...>
	 *
	 * 关键是 version 里**含空格**（真实的 "SMP Tue Nov 14 ..." 就是），
	 * 所以只能按空格切两刀，剩下的整段都算 version。
	 * 第一版按三刀切，第三段被截成第一个单词，然后 kstrtol 之外的空段
	 * 检查把它判成 EINVAL —— 表现是 echo 返回 "Invalid argument"。 */
	tok_pid = strsep(&cursor, " ");
	tok_rel = cursor ? strsep(&cursor, " ") : NULL;
	tok_ver = cursor;   /* 余下全部，允许含空格 */

	if (!tok_pid || !tok_rel || !tok_ver) {
		pr_info("liveapi_uts: parse fail pid=%d rel=%d ver=%d\n",
			!!tok_pid, !!tok_rel, !!tok_ver);
		ret = -EINVAL;
		goto out;
	}

	/* strsep 切完可能留下前导空格 */
	while (*tok_ver == ' ')
		tok_ver++;

	if (kstrtol(tok_pid, 10, &pid) != 0 || pid <= 0) {
		ret = -EINVAL;
		goto out;
	}

	/* find_task_by_vpid 在 5.15 没有 EXPORT_SYMBOL，模块链不上。
	 * 改用 find_get_pid + get_pid_task：前者按 vpid 拿 struct pid
	 * （带引用计数），后者转成 task 并加引用。两个都导出。
	 * 语义等价 —— find_task_by_vpid 内部就是 pid_task(find_vpid(pid), PIDTYPE_PID)。 */
	{
		struct pid *pidp = find_get_pid(pid);
		if (!pidp) {
			ret = -ESRCH;
			goto out;
		}
		task = get_pid_task(pidp, PIDTYPE_PID);
		put_pid(pidp);
	}
	if (!task) {
		pr_info("liveapi_uts: no task for pid %ld\n", pid);
		ret = -ESRCH;
		goto out;
	}

	/* nsproxy 在 task 生命周期内稳定；容器内所有进程共享同一个 uts_ns */
	ns = task->nsproxy ? task->nsproxy->uts_ns : NULL;
	if (!ns) {
		put_task_struct(task);
		ret = -ENOENT;
		goto out;
	}

	/* uts_ns->name 是 struct new_utsname，release/version 各 65 字节。
	 * 这里不加锁：写的是定长字段，且同一容器的进程极少并发读，
	 * 最坏情况读到半更新，不影响可用性。 */
	/* 与 init_uts_ns 比的是 ns 指针本身，不是某个字段的地址 ——
	 * 写成字段比较会退化成比较两个数组的地址，恒为真且编译器会警告。 */
	if (ns != &init_uts_ns) {
		/* 防止误改宿主机自己的 uts_ns（那是 init_uts_ns） */
		mutex_lock(&liveapi_lock);
		strscpy(ns->name.release, tok_rel, sizeof(ns->name.release));
		strscpy(ns->name.version, tok_ver, sizeof(ns->name.version));
		snprintf(last_result, sizeof(last_result),
			 "pid=%ld release=%s version=%s", pid,
			 ns->name.release, ns->name.version);
		mutex_unlock(&liveapi_lock);
	} else {
		/* 目标就在 init_uts_ns 里 —— 那是宿主机本身，拒绝改写，
		 * 否则一台机器上所有容器跟着变，反而更容易被识别 */
		pr_info("liveapi_uts: pid %ld resolves to init_uts_ns (%px), refusing\n",
			pid, ns);
		ret = -EPERM;
	}

	put_task_struct(task);
out:
	if (ret < 0)
		return ret;
	kfree(kbuf);
	return len;
}

static const struct proc_ops liveapi_ops = {
	.proc_read  = liveapi_read,
	.proc_write = liveapi_write,
};

static int __init liveapi_uts_init(void)
{
	liveapi_proc = proc_create(PROC_NAME, 0600, NULL, &liveapi_ops);
	if (!liveapi_proc)
		return -ENOMEM;
	strscpy(last_result, "ready", sizeof(last_result));
	pr_info("liveapi_uts: loaded, interface /proc/%s\n", PROC_NAME);
	return 0;
}

static void __exit liveapi_uts_exit(void)
{
	proc_remove(liveapi_proc);
	pr_info("liveapi_uts: unloaded\n");
}

MODULE_LICENSE("GPL");
MODULE_AUTHOR("live-api");
MODULE_DESCRIPTION("Per-namespace UTS release/version rewriter");
module_init(liveapi_uts_init);
module_exit(liveapi_uts_exit);
