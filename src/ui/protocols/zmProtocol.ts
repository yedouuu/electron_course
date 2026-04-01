import { 
  ProtocolParser, 
  CDMCommandCode,
  BaseProtocolData,
  CountingProtocolData,
  ZMCommandCode
} from '../common/types';
import { 
  hexStringToBytes,
  validateProtocolHeader,
  cleanHexString,
  bytesToLittleEndianInt,
  bytesToString,
  debugLog,
  warningLog
} from './utils';

/**
 * ZM协议解析器
 * 支持协议格式：AA55 + 长度 + 模式码(0x01 0xXX) + 数据 + CRC + A55A
 */
export class ZMProtocolParser implements ProtocolParser<BaseProtocolData[]> {
  private static readonly PROTOCOL_HEADER = [0xAA, 0x55];
  // private static readonly PROTOCOL_TAIL = [0xA5, 0x5A];
  private static readonly PROTOCOL_HEADER_STR = "AA55";
  // private static readonly PROTOCOL_TAIL_STR = "A55A";
  // private static readonly MIN_PACKET_LENGTH = 14; // 7字节 = 14个十六进制字符 (最小包：头部4 + 长度4 + MODE4 + CRC2 + 尾部4)
  private static readonly OVERHEAD_LENGTH = 14;   // 头部4 + 长度4 + CRC2 + 尾部4
  // private static readonly HEAD_LENGTH = 4;        // 头部4 + 长度4 + CRC2 + 尾部4

  // 用于缓存分包场景下的不完整数据帧
  private remainingBuffer: string = '';

  getProtocolName(): string {
    return "ZMProtocol";
  }

  private logProtocolEvent(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    const electronApi = typeof window !== 'undefined' ? window?.electron : undefined;
    if (!electronApi?.writeLog) return;

    void electronApi.writeLog({
      level,
      channel: "ui-protocol",
      source: this.getProtocolName(),
      message,
      metadata,
    });
  }
  
  canHandle(hexData: string): boolean {
    // 如果有缓存的不完整数据帧，则继续接收后续分包
    if (this.remainingBuffer.length > 0) {
      return true;
    }

    const cleanHex = cleanHexString(hexData);

    // 不再限制最小长度，由 parse() 负责缓存等待后续分包。
    // 接受以 AA55 开头的帧，也接受 AA55 头部的任意前缀（如只有 "AA" 或 "AA55" 的前3字符），
    // 防止 Windows 驱动将帧头 "AA 55" 本身也拆成两次 data 事件。
    return "AA55".startsWith(cleanHex.slice(0, 4));
  }
  
  parse(hexData: string): BaseProtocolData[] | null {
    try {
      // console.log(`[${this.getProtocolName()}] Parsing data: ${hexData}`);
      const cleanHex = cleanHexString(hexData);

      // 将上次缓存的不完整帧与本次数据拼接（处理Windows分包）
      const combinedHex = this.remainingBuffer + cleanHex;
      this.remainingBuffer = '';

      const results: BaseProtocolData[] = [];

      // 阶段1: 数据不足 4 字符，无法确认 AA55 头部
      if (combinedHex.length < 4) {
        // 若仍是 AA55 的合法前缀则缓存，等待后续分包补全头部
        if (ZMProtocolParser.PROTOCOL_HEADER_STR.startsWith(combinedHex)) {
          this.remainingBuffer = combinedHex;
        }
        return null;
      }

      // 阶段2: 头部不是 AA55，数据不属于本协议，丢弃
      if (!combinedHex.startsWith(ZMProtocolParser.PROTOCOL_HEADER_STR)) {
        this.logProtocolEvent("warn", "Cannot handle protocol data", {
          hexLength: combinedHex.length,
          preview: combinedHex.slice(0, 64),
        });
        return null;
      }

      // 阶段3: AA55 头部确认，交 extractProtocols 处理；
      // 长度不足时 extractProtocols 内部会将剩余数据存入 remainingBuffer

      // 处理粘包/分包情况：提取多个协议包
      const protocols = this.extractProtocols(combinedHex);

      // 解析第一个有效的协议包
      for (const protocolHex of protocols) {
        const result = this.parseSingleProtocol(protocolHex);
        if (result) {
          results.push(result);
        }
      }

      this.logProtocolEvent("info", "Protocol parse finished", {
        packetCount: protocols.length,
        parsedCount: results.length,
        bufferedBytes: this.remainingBuffer.length / 2,
      });



      return results.length > 0 ? results : null;

    } catch (error) {
      console.error(`[${this.getProtocolName()}] Error parsing protocol data:`, error);
      this.logProtocolEvent("error", "Error parsing protocol data", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
  
  /**
   * 提取协议包
   * 同时处理粘包（多帧合并）和分包（单帧被拆分）两种情况。
   * 不完整的帧尾会保存到 remainingBuffer，等待下次数据到来后拼接。
   *
   * @param hexData 十六进制数据字符串
   * @returns 提取到的完整协议包数组
   */
  private extractProtocols(hexData: string): string[] {
    const protocols: string[] = [];
    let position = 0;

    while (position < hexData.length) {
      // 查找协议头
      const headerIndex = hexData.indexOf(ZMProtocolParser.PROTOCOL_HEADER_STR, position);
      if (headerIndex === -1) {
        break; // 没有找到更多协议头
      }

      // 检查是否有足够的数据来读取长度字段（4字节头 + 4字节长度）
      if (headerIndex + 8 > hexData.length) {
        // 帧头已找到但长度字段不全，保存剩余数据等待分包
        this.remainingBuffer = hexData.substr(headerIndex);
        this.logProtocolEvent("warn", "Incomplete packet header buffered for reassembly", {
          bufferedBytes: this.remainingBuffer.length / 2,
        });
        break;
      }

      // 读取长度字段（第5-6个字节，即位置 headerIndex + 4）
      const lengthHex = hexData.substr(headerIndex + 4, 4); // 2字节长度 = 4个十六进制字符

      // 长度字段为小端序发送
      const dataLength = bytesToLittleEndianInt(hexStringToBytes(lengthHex), 0, 2);

      // 长度字段只包含净荷部分，模式码+参数部分
      const totalPacketLength = dataLength * 2 + ZMProtocolParser.OVERHEAD_LENGTH; // 数据长度*2，1个字节对应2个十六进制字符

      // 检查是否有完整的协议包
      if (headerIndex + totalPacketLength <= hexData.length) {
        const protocolHex = hexData.substr(headerIndex, totalPacketLength);
        protocols.push(protocolHex);
        position = headerIndex + totalPacketLength;
      } else {
        // 不完整的包：保存剩余数据到缓冲区，等待下次分包数据到来
        this.remainingBuffer = hexData.substr(headerIndex);
        this.logProtocolEvent("warn", "Incomplete packet buffered for reassembly", {
          expectedTotalLength: totalPacketLength / 2,
          actualLength: (hexData.length - headerIndex) / 2,
          bufferedBytes: this.remainingBuffer.length / 2,
        });
        break;
      }
    }

    console.log(`[${this.getProtocolName()}] Extracted protocols:`, protocols);
    return protocols;
  }
  
  /**
   * 解析单个ZM协议包
   * 解析格式：AA55 + 长度 + 模式码(0x01 0xXX) + 数据 + CRC
   * 转换为字节数组后进行验证和解析。
   * 
   * 验证步骤：
   * 1. 验证协议头是否为AA55
   * 2. 验证长度字段是否正确
   * 3. 验证模式码字段
   * 4. 验证校验和
   * 
   * @param hexData 十六进制数据字符串
   * @returns 解析后的协议数据或null
   */
  private parseSingleProtocol(hexData: string): BaseProtocolData | null {
    try {
      const bytes = hexStringToBytes(hexData);
      debugLog(`[${this.getProtocolName()}] Parsed bytes:`, bytes);

      // 验证最小长度 (AA55 + 长度 + 模式码 + CRC + A55A = 2 + 2 + 2 + 1 + 2 = 9字节最小)
      if (bytes.length < 9) {
        warningLog(`[${this.getProtocolName()}] Packet too short:`, bytes.length);
        this.logProtocolEvent("warn", "Packet too short", {
          packetBytes: bytes.length,
        });
        return null;
      }
      
      // 验证协议头
      if (!validateProtocolHeader(bytes, ZMProtocolParser.PROTOCOL_HEADER)) {
        warningLog(`[${this.getProtocolName()}] Invalid protocol header:`, bytes[0], bytes[1]);
        this.logProtocolEvent("warn", "Invalid protocol header", {
          header0: bytes[0],
          header1: bytes[1],
        });
        return null;
      }
      
      // 解析长度字段（第3-4个字节，索引2）
      const dataLength = bytes[2] | (bytes[3] << 8); // 小端序

      // 总长度 = 长度字段(2) + dataLength(模式+数据) + CRC(1) + A55A(2)
      const expectedTotalLength = 2 + dataLength + 1 + 2;

      if (bytes.length < expectedTotalLength) {
        warningLog(`[${this.getProtocolName()}] Incomplete packet. Expected:`, expectedTotalLength, 'Got:', bytes.length);
        this.logProtocolEvent("warn", "Incomplete packet", {
          expectedTotalLength,
          actualLength: bytes.length,
        });
        return null;
      }
      
      // 解析CMD-G（模式码，紧跟在长度字段后的2字节,暂时只用一字节，另一个字节默认为0x01）
      const cmdGroup = bytes[5];
      
      // 解析数据部分（CMD-G后到CRC前）
      const dataStart = 6;
      const dataEnd = bytes.length - 2; // CRC前的最后2字节是尾部A55A
      const data = bytes.slice(dataStart, dataEnd);
      
      // 解析CRC（倒数第3字节）
      const crc = bytes[bytes.length - 3];

      // 验证校验和, 只计算Mode + Data部分
      if (!this.validateCheckSUM(bytes.slice(4, bytes.length - 3), crc)) {
        warningLog(`[${this.getProtocolName()}] CheckSUM validation failed`);
        this.logProtocolEvent("warn", "Checksum validation failed", {
          cmdGroup,
        });
        return null;
      }

      const parsedData = this.parseDataByCmdGroup(cmdGroup, data);
      console.log(`[${this.getProtocolName()}] Parsed data:`, parsedData);

      if (parsedData) {
        const countingData = parsedData as CountingProtocolData;
        this.logProtocolEvent("info", "Single packet parsed", {
          timestamp: countingData.timestamp,
          protocolType: countingData.protocolType,
          cmdGroup: countingData.cmdGroup,
          rawData: countingData.rawData,
          check: countingData.check,
          length: countingData.length,
          totalCount: countingData.totalCount,
          denomination: countingData.denomination,
          totalAmount: countingData.totalAmount,
          currencyCode: countingData.currencyCode,
          serialNumber: countingData.serialNumber,
          machineMode: countingData.machineMode,
          reserved1: countingData.reserved1,
          errorCode: countingData.errorCode,
          status: countingData.status,
          reserved2: countingData.reserved2,
          crc: countingData.crc,
          dataLength: data.length,
        });
      } else {
        this.logProtocolEvent("warn", "Unsupported CMD group", {
          cmdGroup,
          dataLength: data.length,
        });
      }

      return parsedData;

    } catch (error) {
      debugLog(`[${this.getProtocolName()}] Error parsing single protocol:`, error);
      this.logProtocolEvent("error", "Error parsing single protocol", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
  
  private parseDataByCmdGroup(cmdGroup: number, data: number[]): BaseProtocolData | null {
    debugLog(`[${this.getProtocolName()}] Parsing data by CMD-G: ${cmdGroup}`, data);
    const base_packet: BaseProtocolData = {
      timestamp: new Date().toLocaleString(),
      protocolType: this.getProtocolName(),
      cmdGroup: cmdGroup,
      rawData: data.map(byte => byte.toString(16).padStart(2, '0')).join(' '),
    }
    switch (cmdGroup) {
      case ZMCommandCode.HANDSHAKE:
        return {
          ...base_packet,
        };
      case ZMCommandCode.COUNT_RESULT:
        return { 
          ...this.parseCountResultData(data),
          ...base_packet
        };
      default:
        return null;
    }
  }

  /**
   * 解析计数结果数据
   */
  private parseCountResultData(data: number[]): CountingProtocolData {
  
  // 假设数据格式：总数(4字节) + 面额(2字节) + 状态(1字节) + 模式(1字节)
  // 解析协议数据
  const totalCount = bytesToLittleEndianInt(data, 0, 4);
  const denomination = bytesToLittleEndianInt(data, 4, 4);
  const totalAmount = bytesToLittleEndianInt(data, 8, 8);
  
  // 解析货币代码和序列号
  const currencyCode = bytesToString(data, 16, 4);
  const serialNumber = bytesToString(data, 20, 11);

  return {
    timestamp: new Date().toLocaleString(),
    protocolType: this.getProtocolName(),
    rawData: data.map(byte => byte.toString(16).padStart(2, '0')).join(' '),
    totalCount,
    denomination,
    totalAmount,
    currencyCode,
    serialNumber,
    reserved1: data.slice(31, 36),
    errorCode: data[36],
    status: data[37],
    reserved2: data[38],
  };
}

  /**
   * 验证CRC校验码
   */
  // private validateCRC(data: number[], expectedCRC: number): boolean {
  //   const calculatedCRC = this.calculateCRC(data);
  //   return calculatedCRC === expectedCRC;
  // }

  private validateCheckSUM(data: number[], expectedCheckSUM: number): boolean {
    const calculatedCheckSUM = this.calculateCheckSUM(data);
    return calculatedCheckSUM === expectedCheckSUM;
  }

  private calculateCheckSUM(data: number[]): number {
    const sum = data.reduce((acc, byte) => acc + byte, 0);
    return sum & 0xFF;
  }

  /**
   * 计算CRC校验码（使用CRC-16-CCITT算法）
   */
  // private calculateCRC(data: number[]): number {
  //   let crc = 0x00;
    
  //   for (const byte of data) {
  //     crc ^= byte;
  //     for (let i = 0; i < 8; i++) {
  //       if (crc & 0x80) {
  //         crc = (crc << 1) ^ 0x31;
  //       } else {
  //         crc = crc << 1;
  //       }
  //     }
  //   }

  //   return crc & 0xFF;
  // }
}

/**
 * 获取CDM命令名称
 */
export function getCDMCommandName(cmdGroup: number): string {
  const commandNames: Record<number, string> = {
    [CDMCommandCode.COUNT_RESULT]: '计数结果',
  };
  
  return commandNames[cmdGroup] || `未知命令(${cmdGroup})`;
}
