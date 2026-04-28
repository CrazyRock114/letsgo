import { createEmptyBoard, playMove, type Board, type Stone } from '../src/lib/go-logic';

// 用户提供的对局：坐标是"列+行"，行从底部开始
// playMove(row, col) 中 row 从顶部开始（0=顶部），需要转换
function toRow(userRow: number, size: number) { return size - userRow; }

const moves: Array<{col:string;userRow:number;color:Stone;label:string}> = [
  {col:'G',userRow:6,color:'black',label:'G6'},
  {col:'G',userRow:7,color:'white',label:'G7'},
  {col:'F',userRow:7,color:'black',label:'F7'},
  {col:'B',userRow:8,color:'white',label:'B8'},
  {col:'G',userRow:8,color:'black',label:'G8'},
  {col:'C',userRow:3,color:'white',label:'C3'},
  {col:'H',userRow:7,color:'black',label:'H7'},
  {col:'E',userRow:4,color:'white',label:'E4'},
  {col:'F',userRow:4,color:'black',label:'F4'},
  {col:'C',userRow:5,color:'white',label:'C5'},
  {col:'E',userRow:5,color:'black',label:'E5'},
  {col:'C',userRow:6,color:'white',label:'C6'},
  {col:'E',userRow:3,color:'black',label:'E3'},
  {col:'G',userRow:4,color:'white',label:'G4'},
  {col:'D',userRow:4,color:'black',label:'D4'},
  {col:'D',userRow:7,color:'white',label:'D7'},
];

const COL_MAP: Record<string,number> = {A:0,B:1,C:2,D:3,E:4,F:5,G:6,H:7,J:8};

// Mock KataGo 分析数据，用于测试走子质量评估
function makeMockAnalysis(blackWR: number, topMoves: string[]): {
  winRate: number; scoreLead: number; bestMoves: {move: string; winrate: number; scoreMean: number}[]
} {
  return {
    winRate: blackWR,
    scoreLead: (blackWR - 50) / 5,
    bestMoves: topMoves.map((m, i) => ({
      move: m,
      winrate: blackWR + (3 - i) * 2,
      scoreMean: (blackWR - 50) / 5 + (3 - i),
    })),
  };
}

// 为每手构造 previousAnalysis 和 currentAnalysis
// 关键场景：第6手白C3不跑G7 → 构造为 mistake
const mockAnalyses: Array<{
  previous: ReturnType<typeof makeMockAnalysis>;
  current: ReturnType<typeof makeMockAnalysis>;
}> = [
  { previous: makeMockAnalysis(50, ['G6','F7','C3']), current: makeMockAnalysis(52, ['G7','F7','C3']) }, // 1黑G6
  { previous: makeMockAnalysis(52, ['G7','F7','C3']), current: makeMockAnalysis(50, ['F7','G8','C3']) }, // 2白G7
  { previous: makeMockAnalysis(50, ['F7','G8','C3']), current: makeMockAnalysis(53, ['G8','B8','C3']) }, // 3黑F7
  { previous: makeMockAnalysis(53, ['G8','B8','C3']), current: makeMockAnalysis(51, ['B8','C3','E4']) }, // 4白B8
  { previous: makeMockAnalysis(51, ['B8','C3','E4']), current: makeMockAnalysis(58, ['C3','H7','E4']) }, // 5黑G8 - 打吃G7，黑方胜率上升
  { previous: makeMockAnalysis(58, ['G7','H7','C3']), current: makeMockAnalysis(68, ['H7','E4','F4']) }, // 6白C3 - 不跑G7，白方胜率暴跌10%!
  { previous: makeMockAnalysis(68, ['H7','E4','F4']), current: makeMockAnalysis(70, ['E4','F4','C5']) }, // 7黑H7 - 提子
  { previous: makeMockAnalysis(70, ['E4','F4','C5']), current: makeMockAnalysis(68, ['F4','C5','E5']) }, // 8白E4
  { previous: makeMockAnalysis(68, ['F4','C5','E5']), current: makeMockAnalysis(69, ['C5','E5','C6']) }, // 9黑F4
  { previous: makeMockAnalysis(69, ['C5','E5','C6']), current: makeMockAnalysis(67, ['E5','C6','E3']) }, // 10白C5
  { previous: makeMockAnalysis(67, ['E5','C6','E3']), current: makeMockAnalysis(70, ['C6','E3','G4']) }, // 11黑E5
  { previous: makeMockAnalysis(70, ['C6','E3','G4']), current: makeMockAnalysis(68, ['E3','G4','D4']) }, // 12白C6
  { previous: makeMockAnalysis(68, ['E3','G4','D4']), current: makeMockAnalysis(72, ['G4','D4','D7']) }, // 13黑E3 - 打吃E4
  { previous: makeMockAnalysis(72, ['E4','G4','D4']), current: makeMockAnalysis(80, ['D4','D7','B5']) }, // 14白G4 - 不跑E4，白方胜率暴跌8%!
  { previous: makeMockAnalysis(80, ['D4','D7','B5']), current: makeMockAnalysis(82, ['D7','B5','B6']) }, // 15黑D4 - 提子
  { previous: makeMockAnalysis(82, ['D7','B5','B6']), current: makeMockAnalysis(80, ['B5','B6','E6']) }, // 16白D7
];

async function callCommentary(
  board: Board,
  currentPlayer: Stone,
  lastMove: {r:number;c:number},
  moveColor: Stone,
  captured: number,
  moveHistory: any[],
  previousAnalysis?: ReturnType<typeof makeMockAnalysis>,
  currentAnalysis?: ReturnType<typeof makeMockAnalysis>
) {
  const boardStr = board.map(row => row.map(c => c ?? 'empty'));
  const body: Record<string, unknown> = {
    type: 'commentary',
    board: boardStr,
    currentPlayer,
    lastMove: {row: lastMove.r, col: lastMove.c},
    moveColor,
    captured,
    moveHistory,
    isPass: false,
  };
  if (previousAnalysis) body.previousAnalysis = previousAnalysis;
  if (currentAnalysis) body.analysis = currentAnalysis;

  const res = await fetch('http://localhost:3000/api/go-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.text();
}

async function main() {
  let board = createEmptyBoard(9);
  const history: Array<{position:{r:number;c:number};color:Stone;captured:number}> = [];

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const r = toRow(m.userRow, 9);
    const c = COL_MAP[m.col];
    const res = playMove(board, r, c, m.color);
    board = res.newBoard;
    history.push({ position: {r,c}, color: m.color, captured: res.captured });

    const mock = mockAnalyses[i];
    const commentary = await callCommentary(
      board,
      m.color === 'black' ? 'white' : 'black',
      {r,c},
      m.color,
      res.captured,
      history.map(h => ({ position: h.position, color: h.color })),
      mock?.previous,
      mock?.current
    );
    const hasRag = commentary.includes('职业') || commentary.includes('棋手');
    const hasPraise = /好棋|不错|漂亮|好方法|好位置|精彩|厉害|棒|完美|优秀|提得漂亮|打得好/.test(commentary);
    const hasQuality = commentary.includes('失误') || commentary.includes('大失误') || commentary.includes('AI推荐') || commentary.includes('首选');
    console.log(`第${i+1}手 | ${m.color==='black'?'黑方':'白方'} ${m.label}`);
    if (mock?.previous && mock?.current) {
      const wrBefore = m.color === 'black' ? mock.previous.winRate : (100 - mock.previous.winRate);
      const wrAfter = m.color === 'black' ? mock.current.winRate : (100 - mock.current.winRate);
      const delta = wrAfter - wrBefore;
      console.log(`  [胜率变化] ${m.color==='black'?'黑方':'白方'}: ${wrBefore.toFixed(0)}% → ${wrAfter.toFixed(0)}% (${delta>=0?'+':''}${delta.toFixed(1)}%)`);
    }
    console.log(commentary);
    if (hasRag) console.log('  [RAG引用]');
    if (hasPraise) console.log('  [无脑夸奖]');
    if (hasQuality) console.log('  [有质量评价]');
    console.log('');
  }
}

main().catch(console.error);
