/**
 * 分包模拟发送测试工具
 *
 * 用法：
 *   node scripts/test-fragment-sender.mjs [COM端口] [测试场景]
 *
 * 示例：
 *   node scripts/test-fragment-sender.mjs COM6          # 运行所有场景
 *   node scripts/test-fragment-sender.mjs COM6 1        # 只运行场景1
 *
 * 前置条件：
 *   1. 安装 com0com，创建虚拟串口对（如 COM5 ↔ COM6）
 *   2. 将 APP 连接到 COM5
 *   3. 本脚本写入 COM6
 */

import { SerialPort } from 'serialport';

const SENDER_PORT = process.argv[2] ?? 'COM15';
const SCENARIO    = process.argv[3] ? Number(process.argv[3]) : 0; // 0 = 全部
const BAUD_RATE   = 115200;

// ─── 测试数据包（来自真实设备日志，CRC 已验证） ───────────────────────────

/** COUNT_RESULT 完整帧 48 字节（totalCount=25, denomination=100, PLN） */
const PACKET_COUNT_RESULT = Buffer.from(
  'AA55290001011900000064000000C409000000000000504C4E00' +
  '5F5F5F5F5F5F5F5F5F5F5F0000000000000100' +
  '4CA55A',
  'hex'
);

/** HANDSHAKE 完整帧 9 字节 */
const PACKET_HANDSHAKE = Buffer.from('AA550200010001A55A', 'hex');

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function hexDump(buf, label) {
  const hex = buf.toString('hex').toUpperCase().replace(/.{2}/g, '$& ').trim();
  console.log(`  ${label} (${buf.length}B): ${hex}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function openPort(path, baudRate) {
  const port = new SerialPort({ path, baudRate, autoOpen: false });
  await new Promise((resolve, reject) => {
    port.open(err => err ? reject(err) : resolve());
  });
  console.log(`✓ 已连接到 ${path} @ ${baudRate}\n`);
  return port;
}

async function write(port, buf) {
  await new Promise((resolve, reject) => {
    port.write(buf, err => err ? reject(err) : resolve());
  });
}

/**
 * 发送分包数据
 * @param {SerialPort} port
 * @param {Buffer} packet 完整数据包
 * @param {number} splitAt 从第几字节切割（0 < splitAt < packet.length）
 * @param {number} gapMs 两片之间的延迟毫秒数（> 10ms 才能触发分包bug）
 */
async function sendFragmented(port, packet, splitAt, gapMs) {
  const chunk1 = packet.subarray(0, splitAt);
  const chunk2 = packet.subarray(splitAt);
  hexDump(chunk1, '第1片');
  await write(port, chunk1);
  console.log(`  ↑ 发送完毕，等待 ${gapMs}ms...`);
  await delay(gapMs);
  hexDump(chunk2, '第2片');
  await write(port, chunk2);
  console.log('  ↑ 发送完毕\n');
}

// ─── 测试场景 ────────────────────────────────────────────────────────────────

const SCENARIOS = [
  {
    id: 1,
    name: '场景1 — 复现日志 [06:24:21.673] 分包（40 + 8 字节，间隔 20ms）',
    run: async (port) => {
      // 与用户反馈的第一条日志完全一致
      await sendFragmented(port, PACKET_COUNT_RESULT, 40, 20);
    },
  },
  {
    id: 2,
    name: '场景2 — 复现日志 [06:24:21.500] 尾部分包（47 + 1 字节，间隔 20ms）',
    run: async (port) => {
      // 只差最后 1 字节 0x5A 的极端情况
      await sendFragmented(port, PACKET_COUNT_RESULT, 47, 20);
    },
  },
  {
    id: 3,
    name: '场景3 — 逐字节发送（压力测试，每字节间隔 2ms）',
    run: async (port) => {
      console.log(`  发送 ${PACKET_COUNT_RESULT.length} 字节，每字节间隔 2ms...`);
      for (let i = 0; i < PACKET_COUNT_RESULT.length; i++) {
        const byte = PACKET_COUNT_RESULT.subarray(i, i + 1);
        await write(port, byte);
        await delay(2);
      }
      console.log('  ↑ 全部发送完毕\n');
    },
  },
  {
    id: 4,
    name: '场景4 — 粘包（连续发送 3 个完整帧，无间隔）',
    run: async (port) => {
      const triple = Buffer.concat([
        PACKET_COUNT_RESULT,
        PACKET_HANDSHAKE,
        PACKET_COUNT_RESULT,
      ]);
      hexDump(triple, '3帧粘包');
      await write(port, triple);
      console.log('  ↑ 发送完毕\n');
    },
  },
  {
    id: 5,
    name: '场景5 — 粘包 + 分包（完整帧 + 下一帧前半段，间隔后再发后半段）',
    run: async (port) => {
      // 先发：完整帧 + 第二帧前40字节（模拟粘包后紧跟分包）
      const combined = Buffer.concat([
        PACKET_COUNT_RESULT,
        PACKET_COUNT_RESULT.subarray(0, 40),
      ]);
      hexDump(combined, '粘包+分包第1片');
      await write(port, combined);
      console.log('  ↑ 发送完毕，等待 25ms...');
      await delay(25);
      // 再发第二帧剩余部分
      const rest = PACKET_COUNT_RESULT.subarray(40);
      hexDump(rest, '分包第2片');
      await write(port, rest);
      console.log('  ↑ 发送完毕\n');
    },
  },
];

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  let port;
  try {
    port = await openPort(SENDER_PORT, BAUD_RATE);
  } catch (err) {
    console.error(`✗ 无法打开串口 ${SENDER_PORT}：${err.message}`);
    console.error('  请确认 com0com 已安装，且端口号正确');
    process.exit(1);
  }

  const toRun = SCENARIO === 0
    ? SCENARIOS
    : SCENARIOS.filter(s => s.id === SCENARIO);

  if (toRun.length === 0) {
    console.error(`✗ 未找到场景 ${SCENARIO}`);
    port.close();
    process.exit(1);
  }

  for (const scenario of toRun) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`▶ ${scenario.name}`);
    console.log('─'.repeat(60));
    await scenario.run(port);
    await delay(200); // 场景间间隔，让 APP 处理完
  }

  port.close();
  console.log('✓ 全部场景执行完毕');
}

main().catch(err => {
  console.error('运行出错：', err);
  process.exit(1);
});
