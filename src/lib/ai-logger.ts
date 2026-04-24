import fs from 'fs';
import path from 'path';

interface AiLogEvent {
  ts: string;
  type: 'genmove' | 'analyze' | 'model_switch' | 'engine_error' | 'game_event' | 'pass_bug';
  model?: string;
  engine?: string;
  boardSize?: number;
  difficulty?: string;
  moveNumber?: number;
  color?: string;
  coord?: string;
  isPass?: boolean;
  visits?: number;
  durationMs?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

const LOG_DIR = path.join(process.cwd(), 'logs', 'ai-events');

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFile(date?: string): string {
  const d = date || new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `${d}.jsonl`);
}

export function logAiEvent(event: Omit<AiLogEvent, 'ts'>): void {
  const fullEvent: AiLogEvent = { ts: new Date().toISOString(), ...event };
  const line = JSON.stringify(fullEvent) + '\n';

  // 1. 写入本地 JSONL 文件（开发/本地测试用）
  try {
    ensureLogDir();
    fs.appendFileSync(getLogFile(), line);
  } catch {
    // 文件写入失败不阻塞主流程
  }

  // 2. 同时输出结构化日志到 stdout（Railway 等会收集）
  console.log(`[ai-log] ${line.trim()}`);
}

export interface DailyReport {
  date: string;
  totalEvents: number;
  genmoveCount: number;
  analyzeCount: number;
  passCount: number;
  errorCount: number;
  modelSwitches: number;
  avgGenmoveMs: number;
  modelsUsed: Record<string, number>;
  errors: string[];
  passBugModels: string[];
}

export function analyzeDailyLogs(date?: string): DailyReport {
  const d = date || new Date().toISOString().slice(0, 10);
  const filePath = getLogFile(d);

  const report: DailyReport = {
    date: d,
    totalEvents: 0,
    genmoveCount: 0,
    analyzeCount: 0,
    passCount: 0,
    errorCount: 0,
    modelSwitches: 0,
    avgGenmoveMs: 0,
    modelsUsed: {},
    errors: [],
    passBugModels: [],
  };

  if (!fs.existsSync(filePath)) {
    return report;
  }

  const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
  let genmoveDurations: number[] = [];

  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as AiLogEvent;
      report.totalEvents++;

      if (evt.model) {
        report.modelsUsed[evt.model] = (report.modelsUsed[evt.model] || 0) + 1;
      }

      switch (evt.type) {
        case 'genmove':
          report.genmoveCount++;
          if (evt.durationMs) genmoveDurations.push(evt.durationMs);
          if (evt.isPass) report.passCount++;
          break;
        case 'analyze':
          report.analyzeCount++;
          break;
        case 'model_switch':
          report.modelSwitches++;
          break;
        case 'engine_error':
          report.errorCount++;
          if (evt.error) report.errors.push(evt.error);
          break;
        case 'pass_bug':
          report.passCount++;
          if (evt.model && !report.passBugModels.includes(evt.model)) {
            report.passBugModels.push(evt.model);
          }
          break;
      }
    } catch {
      // 跳过解析失败的行
    }
  }

  if (genmoveDurations.length > 0) {
    report.avgGenmoveMs = Math.round(genmoveDurations.reduce((a, b) => a + b, 0) / genmoveDurations.length);
  }

  return report;
}
