# -*- coding: utf-8 -*-
import urllib3
from lxml import etree
import html
import re

blogUrl = 'https://blog.csdn.net/qq_28880087'

headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.89 Safari/537.36'} 

def addIntro(f):
	txt = ''' 
专注流媒体,WebRTC，IOT领域的开发
Jitsi项目中的Contributor,WebRTC Community论坛的版主
''' 
	f.write(txt)

def addProjectInfo(f):
	txt ='''
### WebRTC Community
- [WebRTC Community](https://webrtcsample.ink/)WebRTC Community]	
- [WebRTC-Client-Record](https://github.com/daxiondi/WebRTC-Client-Record)WebRTC-Client-Record

   
[查看更多](ttps://github.com/daxiondi/)	 
	''' 
	f.write(txt) 


def addBlogInfo(f):  
	http = urllib3.PoolManager(num_pools=5, headers = headers)
	resp = http.request('GET', blogUrl)
	resp_tree = etree.HTML(resp.data.decode("utf-8"))
	html_data = resp_tree.xpath(".//div[@class='article-item-box csdn-tracking-statistics']/h4") 
	f.write("\n### 我的博客\n")
	cnt = 0
	for i in html_data: 
		if cnt >= 5:
			break
		title = i.xpath('./a/text()')[1].strip()
		url = i.xpath('./a/@href')[0] 
		item = '- [%s](%s)\n' % (title, url)
		f.write(item)
		cnt = cnt + 1
	f.write('\n[查看更多](https://blog.csdn.net/qq_28880087/)\n')


if __name__=='__main__':
	f = open('README.md', 'w+')
	addIntro(f)
	f.write('<table><tr>\n')
	f.write('<td valign="top" width="50%">\n')
	addProjectInfo(f)
	f.write('\n</td>\n')
	f.write('<td valign="top" width="50%">\n')
	addBlogInfo(f)
	f.write('\n</td>\n')
	f.write('</tr></table>\n')
	f.close 