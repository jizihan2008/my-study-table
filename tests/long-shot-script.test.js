'use strict';

// 回归守护：内联 PowerShell 长截图脚本的 C# 源码。
//
// 背景：C# 以前用 Add-Type -TypeDefinition @"..."@ 内联在 .ps1 里。Windows PowerShell 5.1
// 读取**没有 UTF-8 BOM** 的 .ps1 时会按 ANSI(GBK) 解码，C# 里的中文注释被拆坏后
// here-string 边界错位，Add-Type 直接编译失败（"类、结构或接口成员声明中的标记 if 无效"），
// 长截图功能整个不可用。现在 C# 拆成独立的 LONG_SHOT_CS 常量、由主进程落盘为带 BOM 的
// .cs 再 -Path 编译，编译结果不再依赖 .ps1 的读取编码。
//
// 这里做两件事：
//   1) 静态断言：C# 保持纯 ASCII、不再内联 -TypeDefinition、__CS_PATH__ 占位与 -CsPath 参数齐备。
//   2) 真实编译：把 LONG_SHOT_CS 落盘成带 BOM 的 .cs，调用 powershell.exe -Path 编译一次。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extractConst(name) {
  const head = 'const ' + name + ' = `';
  const start = mainSource.indexOf(head);
  if (start < 0) return null;
  const from = start + head.length;
  return mainSource.slice(from, mainSource.indexOf('\n`;', from));
}

const csSource = extractConst('LONG_SHOT_CS');
const psSource = extractConst('LONG_SHOT_PS1');

test('长截图 C# 源码是纯 ASCII', () => {
  assert.ok(csSource, '应能从 main.js 提取 LONG_SHOT_CS');
  const offenders = csSource
    .split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(entry => /[^\x00-\x7F]/.test(entry.line));
  assert.deepEqual(
    offenders.map(o => o.index),
    [],
    'C# 必须保持纯 ASCII（注释只用英文），否则一旦 .cs 被以 ANSI 解码就会编译失败'
  );
});

test('C# 不再内联进 PowerShell，改用外部 .cs 文件编译', () => {
  assert.ok(psSource, '应能从 main.js 提取 LONG_SHOT_PS1');
  // 只拦截真实用法（-TypeDefinition @"..."@），脚本注释里提到该词是允许的
  assert.doesNotMatch(psSource, /-TypeDefinition\s+@?"/, 'PowerShell 脚本不应再内联 -TypeDefinition');
  assert.match(psSource, /-Path "__CS_PATH__"/, '应通过 __CS_PATH__ 占位符引用外部 .cs 文件');
  assert.match(psSource, /\[string\]\$CsPath/, 'PowerShell 脚本应声明 -CsPath 参数');
  assert.doesNotMatch(psSource, /using System;/, 'PowerShell 脚本里不应再残留 C# 代码');
  // 占位符必须恰好一处，否则替换后会有遗留
  assert.equal(psSource.split('__CS_PATH__').length - 1, 1, '__CS_PATH__ 占位符应恰好出现一次');
});

test('两个长截图调用点都传入 C# 源码', () => {
  const calls = mainSource.match(/runPowerShellScript\(LONG_SHOT_PS1[\s\S]{0,320}?\);/g) || [];
  assert.equal(calls.length, 2, '应有 list-windows 与 long-shot 两个调用点');
  for (const call of calls) {
    assert.match(call, /LONG_SHOT_CS/, '调用点必须传入 LONG_SHOT_CS，否则 -CsPath 缺失');
  }
  // helper 必须同时写入带 BOM 的 .cs 并替换占位符
  assert.match(mainSource, /function runPowerShellScript\(script, args, csSource\)/);
  assert.match(mainSource, /writeFileSync\(csPath, '\\uFEFF' \+ csSource/, 'C# 必须以 UTF-8 BOM 落盘');
  assert.match(mainSource, /replace\('__CS_PATH__', csPath\)/);
});

test('C# 源码能被 Add-Type -Path 真实编译', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-ls-compile-'));
  const csPath = path.join(dir, 'native-win.cs');
  fs.writeFileSync(csPath, '\uFEFF' + csSource, 'utf-8');
  try {
    const result = await new Promise((resolve) => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        'Add-Type -AssemblyName System.Drawing; ' +
        `Add-Type -ReferencedAssemblies "System.Drawing" -Path "${csPath}" -PassThru | ` +
        'ForEach-Object { $_.FullName }'
      ], { windowsHide: true });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d.toString('utf8'); });
      child.stderr.on('data', d => { err += d.toString('utf8'); });
      child.on('error', err2 => resolve({ code: -1, out: '', err: String(err2.message || err2) }));
      child.on('close', code => resolve({ code, out: out.trim(), err: err.trim() }));
    });
    assert.equal(result.code, 0, 'C# 编译应成功，stderr: ' + result.err.slice(0, 500));
    assert.match(result.out, /NativeWin/, '编译结果应包含 NativeWin 类型');
    assert.doesNotMatch(result.err, /error CS|Add-Type/, 'stderr 不应出现编译错误: ' + result.err.slice(0, 500));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
