'use client';

import { useRef } from 'react';
import type { Board, Position, Stone } from '@/lib/go-logic';

interface GoBoardProps {
  board: Board;
  boardSize: number;
  lastMove: Position | null;
  showHint: Position | null;
  isAIThinking: boolean;
  isReplayMode: boolean;
  isSpectator?: boolean;
  onMove: (row: number, col: number) => void;
}

const COL_LABELS = 'ABCDEFGHJKLMNOPQRST';

function getStarPoints(size: number): [number, number][] {
  if (size === 9) return [[2, 2], [2, 6], [4, 4], [6, 2], [6, 6]];
  if (size === 13) return [[3, 3], [3, 9], [6, 6], [9, 3], [9, 9], [3, 6], [6, 3], [6, 9], [9, 6]];
  if (size === 19) return [[3, 3], [3, 9], [3, 15], [9, 3], [9, 9], [9, 15], [15, 3], [15, 9], [15, 15]];
  return [];
}

export default function GoBoard({
  board,
  boardSize: size,
  lastMove,
  showHint,
  isAIThinking,
  isReplayMode,
  isSpectator,
  onMove,
}: GoBoardProps) {
  const cellSize = size <= 9 ? 44 : size <= 13 ? 34 : 26;
  const padding = cellSize;
  const stoneRadius = cellSize * 0.44;
  const boardPx = cellSize * (size - 1) + padding * 2;
  const starPts = getStarPoints(size);

  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const lastTouchTimeRef = useRef(0);

  const handleBoardInteraction = (clientX: number, clientY: number, isTouchEvent = false) => {
    if (isTouchEvent) {
      lastTouchTimeRef.current = Date.now();
    } else {
      if (Date.now() - lastTouchTimeRef.current < 500) return;
    }
    const svgEl = document.getElementById('go-board-svg');
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const scaleX = boardPx / rect.width;
    const scaleY = boardPx / rect.height;
    const svgX = (clientX - rect.left) * scaleX;
    const svgY = (clientY - rect.top) * scaleY;
    const col = Math.round((svgX - padding) / cellSize);
    const row = Math.round((svgY - padding) / cellSize);
    if (row >= 0 && row < size && col >= 0 && col < size) {
      const dx = svgX - (padding + col * cellSize);
      const dy = svgY - (padding + row * cellSize);
      if (Math.sqrt(dx * dx + dy * dy) < cellSize * 0.55) {
        onMove(row, col);
      }
    }
  };

  return (
    <svg
      id="go-board-svg"
      width={boardPx}
      height={boardPx}
      viewBox={`0 0 ${boardPx} ${boardPx}`}
      className="max-w-full h-auto"
      style={{ filter: 'drop-shadow(0 8px 24px rgba(0,0,0,0.18))', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
      onClick={(e) => {
        handleBoardInteraction(e.clientX, e.clientY, false);
      }}
      onTouchStart={(e) => {
        const touch = e.changedTouches[0];
        if (touch) {
          touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
        }
      }}
      onTouchMove={(e) => {
        if (!touchStartPosRef.current) return;
        const touch = e.changedTouches[0];
        if (!touch) return;
        const dx = touch.clientX - touchStartPosRef.current.x;
        const dy = touch.clientY - touchStartPosRef.current.y;
        if (Math.sqrt(dx * dx + dy * dy) > 15) {
          touchStartPosRef.current = null;
        }
      }}
      onTouchEnd={(e) => {
        const touch = e.changedTouches[0];
        if (!touch) return;
        lastTouchTimeRef.current = Date.now();
        if (!touchStartPosRef.current) return;
        e.preventDefault();
        handleBoardInteraction(touch.clientX, touch.clientY, true);
      }}
    >
      <defs>
        <radialGradient id="bgGrad" cx="50%" cy="50%">
          <stop offset="0%" stopColor="#dcb87a" />
          <stop offset="100%" stopColor="#c4a06a" />
        </radialGradient>
        <radialGradient id="blackStone" cx="35%" cy="30%">
          <stop offset="0%" stopColor="#666" />
          <stop offset="50%" stopColor="#333" />
          <stop offset="100%" stopColor="#111" />
        </radialGradient>
        <radialGradient id="whiteStone" cx="35%" cy="30%">
          <stop offset="0%" stopColor="#fff" />
          <stop offset="80%" stopColor="#e8e8e8" />
          <stop offset="100%" stopColor="#d0d0d0" />
        </radialGradient>
        <filter id="stoneShadow">
          <feDropShadow dx="1" dy="1" stdDeviation="1.5" floodOpacity="0.3" />
        </filter>
      </defs>

      <rect width={boardPx} height={boardPx} rx="6" fill="url(#bgGrad)" />

      {Array.from({ length: size }, (_, i) => (
        <g key={`line-${i}`}>
          <line x1={padding} y1={padding + i * cellSize} x2={padding + (size - 1) * cellSize} y2={padding + i * cellSize} stroke="#6b5a3e" strokeWidth={size >= 19 ? 0.7 : 1} />
          <line x1={padding + i * cellSize} y1={padding} x2={padding + i * cellSize} y2={padding + (size - 1) * cellSize} stroke="#6b5a3e" strokeWidth={size >= 19 ? 0.7 : 1} />
        </g>
      ))}

      <rect x={padding} y={padding} width={(size - 1) * cellSize} height={(size - 1) * cellSize} fill="none" stroke="#5a4a3a" strokeWidth={size >= 19 ? 1.5 : 2} />

      {starPts.map(([r, c]) => (
        <circle key={`star-${r}-${c}`} cx={padding + c * cellSize} cy={padding + r * cellSize} r={size >= 19 ? 3 : 4} fill="#5a4a3a" />
      ))}

      {Array.from({ length: size }, (_, i) => (
        <g key={`label-${i}`}>
          <text x={padding + i * cellSize} y={padding - cellSize * 0.4} textAnchor="middle" fontSize={size >= 19 ? 9 : 11} fill="#8b7355" fontFamily="sans-serif">{COL_LABELS[i]}</text>
          <text x={padding - cellSize * 0.4} y={padding + i * cellSize + 4} textAnchor="middle" fontSize={size >= 19 ? 9 : 11} fill="#8b7355" fontFamily="sans-serif">{size - i}</text>
        </g>
      ))}

      {board.map((row: Board[number], r: number) =>
        row.map((stone: Stone, c: number) => {
          if (!stone) return null;
          return (
            <g key={`s-${r}-${c}`} filter="url(#stoneShadow)">
              <circle cx={padding + c * cellSize} cy={padding + r * cellSize} r={stoneRadius} fill={stone === 'black' ? 'url(#blackStone)' : 'url(#whiteStone)'} stroke={stone === 'white' ? '#bbb' : 'none'} strokeWidth={0.5} />
            </g>
          );
        })
      )}

      {/* 最新落子标记 — 独立渲染，避免与棋子复用key导致的残留 */}
      {lastMove && board[lastMove.row]?.[lastMove.col] && (
        <circle
          key={`lastmove-${lastMove.row}-${lastMove.col}`}
          cx={padding + lastMove.col * cellSize}
          cy={padding + lastMove.row * cellSize}
          r={stoneRadius * 0.28}
          fill={board[lastMove.row][lastMove.col] === 'black' ? '#fff' : '#333'}
        />
      )}

      {showHint && !board[showHint.row][showHint.col] && (
        <circle cx={padding + showHint.col * cellSize} cy={padding + showHint.row * cellSize} r={stoneRadius} fill="rgba(59,130,246,0.25)" stroke="rgba(59,130,246,0.6)" strokeWidth={2}>
          <animate attributeName="opacity" values="0.4;0.8;0.4" dur="1.5s" repeatCount="indefinite" />
        </circle>
      )}

      {!isAIThinking && !isReplayMode && !isSpectator && board.map((row: Board[number], r: number) =>
        row.map((stone: Stone, c: number) => {
          if (stone) return null;
          return (
            <circle key={`c-${r}-${c}`} cx={padding + c * cellSize} cy={padding + r * cellSize} r={stoneRadius} fill="transparent" cursor="pointer" />
          );
        })
      )}
    </svg>
  );
}
