// 把二进制的函数反编译成 C 伪代码并输出。
//
// 用法：-postScript DumpDecomp.java [<输出文件>] [<函数名过滤>]
//   · 不给过滤：导出全部函数（大二进制会很久）
//   · 给过滤：只导出名字含该子串的函数
//
// 为什么要自己写：Ghidra 自带的脚本偏"分析辅助"，没有直接
// "全部函数导出成可读 C" 的。审计闭源实现需要这个。
import ghidra.app.decompiler.*;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;
import java.io.*;
import java.util.*;

public class DumpDecomp extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        String outPath = args.length > 0 ? args[0] : "/tmp/decomp.c";
        String filter  = args.length > 1 ? args[1] : null;

        DecompInterface dec = new DecompInterface();
        dec.openProgram(currentProgram);

        PrintWriter w = new PrintWriter(new BufferedWriter(new FileWriter(outPath)));
        w.println("// decompiled from: " + currentProgram.getName());
        w.println("// total functions: " + currentProgram.getFunctionManager().getFunctionCount());

        int n = 0, failed = 0;
        FunctionManager fm = currentProgram.getFunctionManager();
        for (Function f : fm.getFunctions(true)) {
            if (monitor.isCancelled()) break;
            String name = f.getName();
            if (filter != null && !name.contains(filter)) continue;
            w.println();
            w.println("// ---- " + name + " @ " + f.getEntryPoint() + " ----");
            try {
                DecompileResults r = dec.decompileFunction(f, 60, monitor);
                if (r.decompileCompleted()) {
                    w.println(r.getDecompiledFunction().getC());
                    n++;
                } else {
                    w.println("// DECOMPILE FAILED: " + r.getErrorMessage());
                    failed++;
                }
            } catch (Exception e) {
                w.println("// ERROR: " + e.getMessage());
                failed++;
            }
            if (n % 200 == 0) println("decompiled " + n + " functions...");
        }
        w.close();
        dec.dispose();
        println("DONE: " + n + " ok, " + failed + " failed -> " + outPath);
    }
}
