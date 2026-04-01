import { describe, it, expect, beforeEach } from 'vitest';
import { ZMProtocolParser } from './zmProtocol';
import { CountingProtocolData } from '../common/types';

// ─────────────────────────────────────────────────────────────────────────────
// 测试数据
// 来自实际设备日志，已人工验证 CRC 正确
// 协议格式: AA55 + 长度(2B LE) + 模式(1B) + CMD-G(1B) + 数据 + CRC(1B) + A55A
// ─────────────────────────────────────────────────────────────────────────────

/**
 * COUNT_RESULT 完整帧 (48 字节)
 * 解析预期: totalCount=25, denomination=100, currencyCode="PLN"
 */
const COUNT_RESULT_FULL =
  'AA 55 29 00 01 01 ' +
  '19 00 00 00 ' +      // totalCount = 25
  '64 00 00 00 ' +      // denomination = 100
  'C4 09 00 00 00 00 00 00 ' + // totalAmount = 2500
  '50 4C 4E 00 ' +      // currencyCode = "PLN"
  '5F 5F 5F 5F 5F 5F 5F 5F 5F 5F 5F ' + // serialNumber = "___________ "
  '00 00 00 ' +          // reserved1 part
  '00 00 00 01 00 ' +    // reserved1 rest + errorCode=0 + status=1
  '4C ' +               // CRC
  'A5 5A';             // tail

/** 分包场景 – 第1片 (前 40 字节，不含 CRC 和尾部) */
const COUNT_RESULT_CHUNK1 =
  'AA 55 29 00 01 01 ' +
  '19 00 00 00 ' +
  '64 00 00 00 ' +
  'C4 09 00 00 00 00 00 00 ' +
  '50 4C 4E 00 ' +
  '5F 5F 5F 5F 5F 5F 5F 5F 5F 5F 5F ' +
  '00 00 00';

/** 分包场景 – 第2片 (后 8 字节，包含末尾数据 + CRC + 尾部) */
const COUNT_RESULT_CHUNK2 = '00 00 00 01 00 4C A5 5A';

/**
 * HANDSHAKE 完整帧 (9 字节)
 * 净荷: 模式(01) + CMD-G(00) = 2 字节
 * CRC = (0x01 + 0x00) & 0xFF = 0x01
 */
const HANDSHAKE_FULL = 'AA 55 02 00 01 00 01 A5 5A';

// ─────────────────────────────────────────────────────────────────────────────

describe('ZMProtocolParser', () => {
  let parser: ZMProtocolParser;

  beforeEach(() => {
    // 每个测试使用全新实例，避免 remainingBuffer 状态泄漏
    parser = new ZMProtocolParser();
  });

  // ───────── canHandle ─────────────────────────────────────────────────────

  describe('canHandle()', () => {
    it('完整帧 → 返回 true', () => {
      expect(parser.canHandle(COUNT_RESULT_FULL)).toBe(true);
    });

    it('只有帧头 AA55 → 返回 true（长度足够识别协议）', () => {
      expect(parser.canHandle('AA 55 00 00 00 00 00')).toBe(true);
    });

    it('数据太短（< 14 hex 字符）→ 返回 false', () => {
      expect(parser.canHandle('AA 55 01')).toBe(false);
    });

    it('错误帧头 → 返回 false', () => {
      expect(parser.canHandle('FD DF 29 00 01 01 00')).toBe(false);
    });

    it('有 remainingBuffer 时，即使传入乱码数据也返回 true', () => {
      // 先解析第一片，触发缓冲
      parser.parse(COUNT_RESULT_CHUNK1);
      // 此时 remainingBuffer 非空，canHandle 应无条件接受后续数据
      expect(parser.canHandle('FF FF FF FF FF FF FF')).toBe(true);
    });
  });

  // ───────── 正常解析 ───────────────────────────────────────────────────────

  describe('parse() – 完整帧', () => {
    it('COUNT_RESULT 完整帧解析成功，返回 1 条结果', () => {
      const result = parser.parse(COUNT_RESULT_FULL);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
    });

    it('解析结果包含正确的 totalCount / denomination / currencyCode', () => {
      const result = parser.parse(COUNT_RESULT_FULL);
      const data = result![0] as CountingProtocolData;
      expect(data.totalCount).toBe(25);
      expect(data.denomination).toBe(100);
      expect(data.currencyCode).toBe('PLN');
    });

    it('HANDSHAKE 完整帧解析成功，返回 1 条结果', () => {
      const result = parser.parse(HANDSHAKE_FULL);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      expect(result![0].cmdGroup).toBe(0x00);
    });

    it('CRC 错误的帧 → 返回 null', () => {
      // 把 CRC 字节从 4C 改成 FF
      const badCrc = COUNT_RESULT_FULL.replace('4C A5 5A', 'FF A5 5A');
      expect(parser.parse(badCrc)).toBeNull();
    });
  });

  // ───────── 分包测试 ───────────────────────────────────────────────────────

  describe('parse() – 分包（Windows 串口拆帧）', () => {
    it('第1片到达 → 返回 null（帧不完整），remainingBuffer 非空', () => {
      const result = parser.parse(COUNT_RESULT_CHUNK1);
      // 帧不完整，不应产生解析结果
      expect(result).toBeNull();
      // 通过 canHandle 检测 remainingBuffer 状态：此时应仍在缓冲
      expect(parser.canHandle('00')).toBe(true);
    });

    it('第2片到达 → 拼接后解析成功，返回 COUNT_RESULT', () => {
      parser.parse(COUNT_RESULT_CHUNK1); // 触发缓冲
      const result = parser.parse(COUNT_RESULT_CHUNK2); // 拼接完成
      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      const data = result![0] as CountingProtocolData;
      expect(data.totalCount).toBe(25);
      expect(data.currencyCode).toBe('PLN');
    });

    it('分包后结果与完整帧结果一致', () => {
      // 完整帧一次性解析
      const fullResult = new ZMProtocolParser().parse(COUNT_RESULT_FULL);

      // 分包解析
      parser.parse(COUNT_RESULT_CHUNK1);
      const fragmentedResult = parser.parse(COUNT_RESULT_CHUNK2);

      const full = fullResult![0] as CountingProtocolData;
      const frag = fragmentedResult![0] as CountingProtocolData;

      expect(frag.totalCount).toBe(full.totalCount);
      expect(frag.denomination).toBe(full.denomination);
      expect(frag.totalAmount).toBe(full.totalAmount);
      expect(frag.currencyCode).toBe(full.currencyCode);
      expect(frag.serialNumber).toBe(full.serialNumber);
      expect(frag.errorCode).toBe(full.errorCode);
      expect(frag.status).toBe(full.status);
    });

    it('成功解析后 remainingBuffer 清空，不影响下一帧', () => {
      parser.parse(COUNT_RESULT_CHUNK1);
      parser.parse(COUNT_RESULT_CHUNK2); // 完成解析，buffer 应清空

      // 此时 canHandle 对正常非AA55数据应返回 false（buffer 已空）
      expect(parser.canHandle('FF FF FF FF FF FF FF')).toBe(false);
    });

    it('极端分包：仅发送前 10 字节（含帧头 + 长度字段），后续才到达剩余数据', () => {
      // 前10字节已通过 MIN_PACKET_LENGTH 检查，但帧远不完整（总帧 48 字节）
      const firstTenBytes = 'AA 55 29 00 01 01 19 00 00 00';
      expect(parser.parse(firstTenBytes)).toBeNull();
      // parse 进入 extractProtocols，发现帧不完整，存入 remainingBuffer
      expect(parser.canHandle('00')).toBe(true);
    });
  });

  // ───────── 粘包测试 ───────────────────────────────────────────────────────

  describe('parse() – 粘包（多帧合并）', () => {
    it('两帧粘包 → 返回 2 条结果', () => {
      const twoPackets = COUNT_RESULT_FULL + ' ' + COUNT_RESULT_FULL;
      const result = parser.parse(twoPackets);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(2);
    });

    it('HANDSHAKE + COUNT_RESULT 粘包 → 返回 2 条结果，类型正确', () => {
      const mixed = HANDSHAKE_FULL + ' ' + COUNT_RESULT_FULL;
      const result = parser.parse(mixed);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(2);
      expect(result![0].cmdGroup).toBe(0x00); // HANDSHAKE
      expect(result![1].cmdGroup).toBe(0x01); // COUNT_RESULT
    });
  });

  // ───────── 粘包 + 分包组合 ────────────────────────────────────────────────

  describe('parse() – 粘包 + 分包 组合', () => {
    it('完整帧 + 不完整帧 → 先返回完整帧结果，不完整帧进入缓冲', () => {
      // 一个完整帧后紧跟分包第1片
      const combined = COUNT_RESULT_FULL + ' ' + COUNT_RESULT_CHUNK1;
      const result = parser.parse(combined);
      // 第一帧可以解析
      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      // 第二帧未完成，应进入缓冲
      expect(parser.canHandle('00')).toBe(true);
    });

    it('接收第2片后，缓冲的分包也能正确解析', () => {
      const combined = COUNT_RESULT_FULL + ' ' + COUNT_RESULT_CHUNK1;
      parser.parse(combined); // 第1完整帧 + 第2帧片段1

      const result = parser.parse(COUNT_RESULT_CHUNK2); // 第2帧片段2
      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      expect((result![0] as CountingProtocolData).totalCount).toBe(25);
    });
  });
});
