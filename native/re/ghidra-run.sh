#!/bin/sh
# Ghidra headless 启动包装。
#
# 为什么要这个脚本：Ghidra 11.2.1 要求 JDK 21+，而系统默认 java 是 11。
# 另外 support/launch.properties 必须同时含 JAVA_HOME_OVERRIDE 和 VMARGS
# （后者缺了会报 "Ghidra class loader not in use"）—— 一次性固化在这里，
# 免得每次手动拼参数。
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export PATH="$JAVA_HOME/bin:$PATH"
exec /opt/ghidra_11.2.1_PUBLIC/support/analyzeHeadless "$@"
