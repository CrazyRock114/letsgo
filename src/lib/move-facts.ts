import type { Board, Position, Stone } from './go-logic';

/** 棋型类型 */
export type PatternType =
  | 'star'
  | 'approach'
  | 'connect'
  | 'cut'
  | 'eye'
  | 'corner'
  | 'edge'
  | 'other';

/** 棋盘区域 */
export type Region = 'corner' | 'edge' | 'center';

/** 结构化棋型描述 */
export interface MovePattern {
  type: PatternType;
  confidence: number; // 0-1
  description: string; // 人类可读，不用于 LLM prompt
}

/** 单步落子的事实骨架 —— LLM 解说必须严格依据此数据 */
export interface MoveFacts {
  // 基础信息
  coordinate: Position;
  color: 'black' | 'white';
  isPass: boolean;

  // 位置特征
  region: Region;
  isStarPoint: boolean;
  distanceToCorner: number; // 到最近角的距离（手数）

  // 气数与提子
  liberties: number;
  captured: number;
  isAtari: boolean;
  isCapture: boolean;

  // 棋型识别
  patterns: MovePattern[];

  // 邻接关系
  adjacentFriendlyStones: number;
  adjacentOpponentStones: number;
  connectedGroups: number;
  separatedGroups: number;

  // 战术棋型
  escapedAtari?: boolean;   // 这步是否解救了被打吃的棋子
  selfAtari?: boolean;      // 这步是否把自己放入打吃
  doubleAtari?: boolean;    // 是否造成双打吃
  isSnapback?: boolean;     // 是否倒扑

  // KataGo 数据
  winRate?: number;
  scoreLead?: number;
  bestMoves?: { move: string; winrate: number; scoreMean: number }[];
}

/** SGF 解析结果 */
export interface ParsedGame {
  boardSize: number;
  komi: number;
  blackPlayer?: { name: string; rank?: string };
  whitePlayer?: { name: string; rank?: string };
  date?: string;
  result?: string;
  moves: SgfMove[];
  rawSgf: string;
}

export interface SgfMove {
  color: 'black' | 'white';
  position?: Position; // undefined = pass
  comment?: string;
}

/** 棋盘快照 —— 用于 RAG 检索和 embedding */
export interface BoardSnapshot {
  // 基础信息
  boardSize: number;
  moveNumber: number;
  color: 'black' | 'white';
  coordinate: Position;
  isPass: boolean;

  // 区域与位置
  region: Region;
  subRegion: string; // 如 "upper-left corner", "right edge"
  isStarPoint: boolean;
  distanceToCorner: number;

  // 棋盘统计
  totalStones: number;
  blackStones: number;
  whiteStones: number;
  blackCaptures: number;
  whiteCaptures: number;

  // 局部棋型（复用 MoveFacts）
  patterns: MovePattern[];
  liberties: number;
  captured: number;
  isAtari: boolean;
  isCapture: boolean;
  adjacentFriendlyStones: number;
  adjacentOpponentStones: number;
  connectedGroups: number;
  separatedGroups: number;

  // 用于 embedding 的自然语言描述
  description: string;

  // KataGo 数据
  winRate?: number;
  scoreLead?: number;
  bestMoves?: { move: string; winrate: number; scoreMean: number }[];

  // 对局元数据
  gameMeta?: {
    blackPlayer?: string;
    whitePlayer?: string;
    komi?: number;
    result?: string;
  };
}
