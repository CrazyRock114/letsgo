import type { Position } from './go-logic';
import type { ParsedGame, SgfMove } from './move-facts';

interface SgfNode {
  properties: Record<string, string[]>;
  children: SgfNode[];
}

/**
 * 解析 SGF 坐标（如 "dd" → {row: 3, col: 3}）
 * SGF: aa = 左上角 (0,0)，ss = 19路右下角 (18,18)
 */
export function parseSgfCoord(sgfCoord: string, boardSize: number): Position | undefined {
  if (!sgfCoord || sgfCoord.length < 2) return undefined;
  const col = sgfCoord.charCodeAt(0) - 97; // 'a' = 0
  const row = sgfCoord.charCodeAt(1) - 97;
  if (col < 0 || col >= boardSize || row < 0 || row >= boardSize) return undefined;
  return { row, col };
}

/** SGF 坐标格式化（如 {row: 3, col: 3} → "dd"） */
export function formatSgfCoord(row: number, col: number): string {
  return String.fromCharCode(97 + col, 97 + row);
}

/**
 * 递归下降 SGF 解析器
 * 只提取主分支（第一个 child），忽略变体
 */
export function parseSgf(sgf: string): ParsedGame {
  let index = 0;

  function peek(): string {
    return sgf[index] || '';
  }

  function consume(): string {
    return sgf[index++] || '';
  }

  function parseValue(): string {
    let value = '';
    while (index < sgf.length) {
      const ch = peek();
      if (ch === '\\') {
        consume(); // skip backslash
        const next = consume();
        if (next === ']' || next === '\\') {
          value += next;
        } else {
          value += '\\' + next;
        }
      } else if (ch === ']') {
        break;
      } else {
        value += consume();
      }
    }
    return value;
  }

  function parseProperties(): Record<string, string[]> {
    const props: Record<string, string[]> = {};
    while (index < sgf.length) {
      const ch = peek();
      if (ch === '(' || ch === ')' || ch === ';') break;

      // Parse property identifier (uppercase letters)
      let propName = '';
      while (/[A-Za-z]/.test(peek())) {
        propName += consume();
      }
      if (!propName) {
        consume(); // skip unexpected char
        continue;
      }

      const values: string[] = [];
      while (peek() === '[') {
        consume(); // skip '['
        values.push(parseValue());
        if (peek() === ']') consume(); // skip ']'
      }

      if (values.length > 0) {
        props[propName] = values;
      }
    }
    return props;
  }

  function parseNode(): SgfNode | null {
    if (peek() !== ';') return null;
    consume(); // skip ';'
    return {
      properties: parseProperties(),
      children: [],
    };
  }

  function parseSequence(): SgfNode[] {
    const nodes: SgfNode[] = [];
    while (index < sgf.length) {
      const ch = peek();
      if (ch === '(' || ch === ')') break;
      if (ch === ';') {
        const node = parseNode();
        if (node) nodes.push(node);
      } else {
        consume(); // skip whitespace/newlines
      }
    }
    return nodes;
  }

  function parseTree(): SgfNode | null {
    if (peek() !== '(') return null;
    consume(); // skip '('

    const nodes = parseSequence();
    if (nodes.length === 0) {
      // skip empty tree
      while (index < sgf.length && peek() !== ')') consume();
      if (peek() === ')') consume();
      return null;
    }

    // Attach children to last node in sequence
    let current = nodes[0];
    for (let i = 1; i < nodes.length; i++) {
      current.children.push(nodes[i]);
      current = nodes[i];
    }

    // Parse child trees (variants)
    while (index < sgf.length && peek() === '(') {
      const child = parseTree();
      if (child) current.children.push(child);
    }

    if (peek() === ')') consume(); // skip ')'

    return nodes[0];
  }

  // Skip leading whitespace
  while (index < sgf.length && /\s/.test(peek())) consume();

  const root = parseTree();
  if (!root) {
    throw new Error('Invalid SGF: no game tree found');
  }

  // Extract game info from root node
  const rootProps = root.properties;
  const boardSize = parseInt(rootProps.SZ?.[0] || '19', 10);
  const komi = parseFloat(rootProps.KM?.[0] || '6.5');

  const blackPlayer = rootProps.PB?.[0]
    ? { name: rootProps.PB[0], rank: rootProps.BR?.[0] }
    : undefined;
  const whitePlayer = rootProps.PW?.[0]
    ? { name: rootProps.PW[0], rank: rootProps.WR?.[0] }
    : undefined;

  // Extract moves from main branch (first child recursively)
  const moves: SgfMove[] = [];
  let current = root;

  while (current.children.length > 0) {
    current = current.children[0];
    const props = current.properties;

    // Handle pass moves (B[] or W[])
    if (props.B) {
      const coord = props.B[0];
      moves.push({
        color: 'black',
        position: coord ? parseSgfCoord(coord, boardSize) : undefined,
        comment: props.C?.[0],
      });
    }
    if (props.W) {
      const coord = props.W[0];
      moves.push({
        color: 'white',
        position: coord ? parseSgfCoord(coord, boardSize) : undefined,
        comment: props.C?.[0],
      });
    }
  }

  return {
    boardSize,
    komi,
    blackPlayer,
    whitePlayer,
    date: rootProps.DT?.[0],
    result: rootProps.RE?.[0],
    moves,
    rawSgf: sgf,
  };
}
