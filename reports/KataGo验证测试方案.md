# KataGo 引擎验证测试方案 (针对 小围棋乐园)

## 测试环境

```bash
# 基础命令模板
KANAGO=/path/to/katago
MODEL=/path/to/model
CONFIG=gtp.cfg

# 交互式测试
./katago gtp -model $MODEL -config $CONFIG

# 批量测试
cat commands.txt | ./katago gtp -model $MODEL -config $CONFIG
```

## T1: 模型-棋盘兼容性测试

### T1.1 b24c64_3x3 模型测试

```bash
# 期望：3x3 正常，9x9 应该 pass 或报错

# 测试 3x3
echo -e "boardsize 3\nclear_board\ngenmove black\nquit" | \
  ./katago gtp -model lionffen_b24c64_3x3_v3_12300.bin.gz -config gtp.cfg

# 测试 9x9（应该 pass）
echo -e "boardsize 9\nclear_board\nplay black D5\ngenmove white\nquit" | \
  ./katago gtp -model lionffen_b24c64_3x3_v3_12300.bin.gz -config gtp.cfg
```

**预期结果**:
| 棋盘 | 预期 | 实际 |
|------|------|------|
| 3x3 | 返回坐标 (非 pass) | 待填 |
| 9x9 | 返回 pass | 待填 |

### T1.2 b6c64 模型测试

```bash
# 测试 9x9, 13x13, 19x19

for size in 9 13 19; do
  echo "Testing b6c64 on ${size}x${size}:"
  echo -e "boardsize $size\nclear_board\nplay black D4\ngenmove white\nquit" | \
    ./katago gtp -model lionffen_b6c64.txt.gz -config gtp.cfg
  echo "---"
done
```

**预期**: 所有尺寸都不应该 pass

### T1.3 kata9x9 模型测试

```bash
# 专门测试 9x9 专精模型

echo -e "boardsize 9\nclear_board\ngenmove black\nquit" | \
  ./katago gtp -model kata9x9.bin.gz -config gtp.cfg

# 尝试 19x19（预期：可能可用或报错）
echo -e "boardsize 19\nclear_board\ngenmove black\nquit" | \
  ./katago gtp -model kata9x9.bin.gz -config gtp.cfg
```

## T2: GTP 命令行为测试

### T2.1 maxVisits 控制测试

**目标**: 验证 GTP 模式下 kata-analyze 是否真的不能用 maxVisits 参数

```bash
# 测试 1: gtp.cfg 中设置 maxVisits
echo "maxVisits = 50" > /tmp/test.cfg
echo -e "boardsize 9\nclear_board\nkata-analyze black 0\nquit" | \
  ./katago gtp -model b6c64.txt.gz -config /tmp/test.cfg

# 观察：是否在 50 visits 后停止
```

**预期**: 如果 gtp.cfg 设置了 maxVisits，kata-analyze 应该遵守

### T2.2 stop 命令中断测试

```bash
# 测试 stop 命令是否能可靠中断 kata-analyze

(
  echo "boardsize 9"
  echo "clear_board"
  echo "kata-analyze black 0"  # 开始分析
  sleep 0.5
  echo "stop"  # 中断
  echo "quit"
) | ./katago gtp -model b6c64.txt.gz -config gtp.cfg

# 验证：输出应该在 stop 后终止
```

### T2.3 连续请求测试（检测错位）

```bash
# 连续发送多个命令，验证响应不错位

(
  echo "boardsize 9"
  echo "clear_board"
  echo "name"              # 请求 1
  echo "version"           # 请求 2
  echo "kata-get-rules"    # 请求 3
  echo "quit"
) | ./katago gtp -model b6c64.txt.gz -config gtp.cfg

# 验证：每个请求都有对应的响应
```

## T3: 胜负视角验证

### T3.1 winrate 视角测试

```bash
# 测试 kata-analyze 返回的 winrate 视角

# 空棋盘，黑先手
echo -e "boardsize 9\nclear_board\nkata-analyze black 0 maxVisits 100\nquit" | \
  ./katago gtp -model b6c64.txt.gz -config gtp.cfg

# 预期：空棋盘黑先手，winrate 应该接近 50%
```

### T3.2 视角转换验证

编写脚本测试视角转换逻辑：

```python
#!/usr/bin/env python3
"""验证胜率视角转换"""

def parse_analyze_output(output_lines):
    """解析 kata-analyze 输出"""
    results = []
    for line in output_lines:
        if line.startswith('info '):
            data = json.loads(line[5:])
            results.append(data)
    return results

def to_black_perspective(results):
    """转换为黑方视角"""
    # 假设当前是黑方行棋
    black_perspective = []
    for r in results:
        winrate = r['winrate']
        # 如果是黑方视角，直接使用
        # 如果是白方视角，1 - winrate
        # 这里需要知道当前行棋方
        black_winrate = winrate if current_player == 'B' else 1 - winrate
        black_perspective.append(black_winrate)
    return black_perspective
```

## T4: 并发安全测试

### T4.1 持久进程并发测试

```bash
# 模拟并发请求（实际应该由代码处理）

(
  # 进程 A: genmove
  (
    echo "boardsize 9"
    echo "clear_board"
    echo "genmove black"
  ) &
  
  # 进程 B: analyze (应该等 genmove 完成后)
  (
    sleep 0.1
    echo "boardsize 9"
    echo "clear_board"
    echo "kata-analyze white 0 maxVisits 50"
    echo "stop"
  )
  
  wait
) | ./katago gtp -model b6c64.txt.gz -config gtp.cfg
```

## T5: 规则一致性测试

### T5.1 验证 komi 设置

```bash
for komi in 6.5 7.5; do
  echo "Testing komi $komi:"
  echo -e "boardsize 9\nkata-set-rules chinese\nkomi $komi\nkata-get-rules\nquit" | \
    ./katago gtp -model b6c64.txt.gz -config gtp.cfg
  echo "---"
done
```

### T5.2 不同规则计分对比

```bash
# Chinese vs Japanese 规则下，验证终局分数

# 设置一个简单局面
#    A B C D E F G H J
# 1  . . . . . . . . .
# 2  . X X . . . . . .  (黑棋)
# 3  . . . . . . . . .
# ...

echo -e "
boardsize 9
kata-set-rules chinese
final_score
quit
" | ./katago gtp -model b6c64.txt.gz -config gtp.cfg

echo -e "
boardsize 9
kata-set-rules japanese
final_score
quit
" | ./katago gtp -model b6c64.txt.gz -config gtp.cfg
```

## T6: 性能基准测试

### T6.1 不同棋盘/visits 性能

```bash
#!/bin/bash

for size in 9 13 19; do
  for visits in 100 500 1000; do
    echo "Board: ${size}x${size}, Visits: $visits"
    
    start=$(date +%s%3N)
    echo -e "boardsize $size\nclear_board\ngenmove black\nquit" | \
      timeout 30 ./katago gtp -model b6c64.txt.gz -config gtp.cfg > /dev/null
    end=$(date +%s%3N)
    
    echo "Time: $((end - start))ms"
    echo "---"
  done
done
```

## 测试结果记录表

| 测试 ID | 测试项 | 预期结果 | 实际结果 | 状态 | 备注 |
|---------|--------|----------|----------|------|------|
| T1.1.1 | b24c64 3x3 | 正常落子 | | | |
| T1.1.2 | b24c64 9x9 | pass | | | |
| T1.2.1 | b6c64 9x9 | 正常落子 | | | |
| T1.2.2 | b6c64 13x13 | 正常落子 | | | |
| T1.2.3 | b6c64 19x19 | 正常落子 | | | |
| T2.1.1 | maxVisits=50 | 遵守限制 | | | |
| T2.2.1 | stop 中断 | 立即停止 | | | |
| T3.1.1 | 空棋盘黑先 | winrate≈50% | | | |

---

## 自动化测试脚本

```python
#!/usr/bin/env python3
"""
KataGo 自动化验证测试
用于小围棋乐园项目的引擎验证
"""

import subprocess
import json
import time
from dataclasses import dataclass
from typing import List, Optional

@dataclass
class TestResult:
    test_id: str
    passed: bool
    expected: str
    actual: str
    notes: str = ""

class KataGoVerifier:
    def __init__(self, katago_path: str, model: str, config: str):
        self.katago_path = katago_path
        self.model = model
        self.config = config
    
    def run_gtp(self, commands: List[str], timeout: int = 10) -> str:
        """运行 GTP 命令序列"""
        proc = subprocess.Popen(
            [self.katago_path, 'gtp', '-model', self.model, '-config', self.config],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        
        output = []
        for cmd in commands:
            proc.stdin.write(f"{cmd}\n")
            proc.stdin.flush()
        
        proc.stdin.write("quit\n")
        proc.stdin.flush()
        
        try:
            # 读取所有输出
            while True:
                line = proc.stdout.readline()
                if not line:
                    break
                output.append(line.strip())
        except:
            pass
        finally:
            proc.wait(timeout=timeout)
        
        return "\n".join(output)
    
    def test_model_board_compatibility(self, model: str, board_size: int) -> TestResult:
        """测试模型和棋盘兼容性"""
        output = self.run_gtp([
            f"boardsize {board_size}",
            "clear_board",
            "genmove black"
        ])
        
        # 检查是否返回 pass
        is_pass = "= pass" in output.lower() or "= resign" in output.lower()
        has_coords = any(c in output for c in "ABCDEFGHJ")
        
        passed = not is_pass if model != "b24c64_3x3" or board_size == 3 else is_pass
        
        return TestResult(
            test_id=f"T1.{model}.{board_size}",
            passed=passed,
            expected="非 pass 落子" if not passed else "pass",
            actual=output
        )
    
    def test_max_visits_respected(self, max_visits: int) -> TestResult:
        """测试 maxVisits 是否被遵守"""
        # 这个测试需要解析 kata-analyze 的输出
        output = self.run_gtp([
            "boardsize 9",
            "clear_board",
            "kata-analyze black 0 maxVisits 50",
            "stop"
        ])
        
        # 统计 info 行中的 visits
        # （实际实现需要解析）
        
        return TestResult(
            test_id=f"T2.maxVisits.{max_visits}",
            passed=True,  # 待实现
            expected=f"不超过 {max_visits} visits",
            actual="TODO"
        )


def main():
    verifier = KataGoVerifier(
        katago_path="./katago",
        model="b6c64.txt.gz",
        config="gtp.cfg"
    )
    
    results = []
    
    # 运行测试
    for model in ["b24c64_3x3", "b6c64", "kata9x9"]:
        for size in [3, 9, 13, 19]:
            result = verifier.test_model_board_compatibility(model, size)
            results.append(result)
            print(f"{result.test_id}: {'✓' if result.passed else '✗'} - {result.actual[:50]}")
    
    # 总结
    passed = sum(1 for r in results if r.passed)
    print(f"\n通过: {passed}/{len(results)}")


if __name__ == "__main__":
    main()
```
