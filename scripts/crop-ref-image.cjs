#!/usr/bin/env node
'use strict';
// 从参考图裁剪循环节点卡片 / 循环体 / 右侧配置面板三个区域，便于精确比对。
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { existsSync } = require('node:fs');

function findBrowser() {
  const c = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return c.find((p) => existsSync(p));
}

const REF = 'D:\\Desktop\\futureFlow\\参考图\\数组是用来循环的，不是单独节点.png';
const OUT = 'D:/Desktop/futureFlow/gui-test-screenshots';

const CROPS = [
  { name: 'ref_loop_card.png', x: 350, y: 260, w: 1150, h: 560, zoom: 2 },
  { name: 'ref_loop_body.png', x: 230, y: 740, w: 1550, h: 600, zoom: 2 },
  { name: 'ref_loop_panel.png', x: 1880, y: 160, w: 680, h: 780, zoom: 2 },
];

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: findBrowser() });
  for (const crop of CROPS) {
    const vw = Math.ceil(crop.w);
    const vh = Math.ceil(crop.h);
    const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: crop.zoom });
    const b64 = fs.readFileSync(REF).toString('base64');
    await page.setContent(`<!doctype html><html><head><style>
      html,body{margin:0;padding:0;overflow:hidden}
      #img{position:absolute;left:${-crop.x}px;top:${-crop.y}px}
    </style></head><body>
      <img id="img" src="data:image/png;base64,${b64}">
    </body></html>`);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, crop.name) });
    console.log('saved', crop.name);
    await page.close();
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
