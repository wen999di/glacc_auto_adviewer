/**
 * preload-host.js — 宿主页面（index.html）preload 脚本
 *
 * 为宿主渲染进程暴露 Electron API（Node.js + ipcRenderer）。
 * 宿主页面通过 ipcRenderer.invoke / ipcRenderer.on 与主进程通信。
 */

'use strict';

// 宿主页面可直接使用 Node.js（nodeIntegration: true），此文件为空占位符
// 实际上 index.html 中直接 require('electron') 使用 ipcRenderer
