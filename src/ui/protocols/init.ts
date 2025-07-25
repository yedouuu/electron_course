import { protocolManager } from './manager';
import { CDMProtocolParser } from './cdmProtocol';
import { ZMProtocolParser } from './zmProtocol';

/**
 * 初始化所有协议解析器
 * 这个函数应该在应用启动时调用
 */
export function initializeProtocols(): void {
  console.log('Initializing protocol parsers...');
  
  // 注册点钞机协议解析器
  // const countingParser = new CountingMachineParser();
  // protocolManager.registerParser(countingParser);
  
  // 注册CDM协议解析器
  const cdmParser = new CDMProtocolParser();
  protocolManager.registerParser(cdmParser);

  const zmParser = new ZMProtocolParser();
  protocolManager.registerParser(zmParser);

  console.log(`Initialized ${protocolManager.getParserCount()} protocol parsers`);
  console.log('Supported protocols:', protocolManager.getSupportedProtocols());
}

/**
 * 清理所有协议解析器
 */
export function cleanupProtocols(): void {
  console.log('Cleaning up protocol parsers...');
  protocolManager.clearAllParsers();
}
