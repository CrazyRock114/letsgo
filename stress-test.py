#!/usr/bin/env python3
"""KataGo 压力测试 - 模拟20个用户同时快速请求KataGo"""

import asyncio
import aiohttp
import time
import json
import sys

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "https://letusgoa.cn"
CONCURRENT_USERS = 20
MOVES_PER_USER = 3  # 每个用户模拟3步

# 预设落子序列（9路棋盘，避免不合法落子）
MOVE_SEQUENCES = [
    [{"row":2,"col":2,"color":"black"}],
    [{"row":2,"col":2,"color":"black"},{"row":6,"col":6,"color":"white"}],
    [{"row":2,"col":6,"color":"black"}],
    [{"row":6,"col":2,"color":"black"},{"row":2,"col":2,"color":"white"}],
    [{"row":4,"col":4,"color":"black"}],
    [{"row":2,"col":4,"color":"black"},{"row":6,"col":4,"color":"white"}],
    [{"row":4,"col":2,"color":"black"}],
    [{"row":4,"col":6,"color":"black"},{"row":2,"col":6,"color":"white"}],
    [{"row":0,"col":0,"color":"black"}],
    [{"row":8,"col":8,"color":"black"},{"row":0,"col":8,"color":"white"}],
    [{"row":0,"col":4,"color":"black"}],
    [{"row":8,"col":4,"color":"black"},{"row":4,"col":0,"color":"white"}],
    [{"row":8,"col":0,"color":"black"}],
    [{"row":0,"col":2,"color":"black"},{"row":8,"col":6,"color":"white"}],
    [{"row":6,"col":0,"color":"black"}],
    [{"row":2,"col":8,"color":"black"},{"row":6,"col":8,"color":"white"}],
    [{"row":3,"col":3,"color":"black"}],
    [{"row":5,"col":5,"color":"black"},{"row":3,"col":5,"color":"white"}],
    [{"row":5,"col":3,"color":"black"}],
    [{"row":1,"col":1,"color":"black"},{"row":7,"col":7,"color":"white"}],
]

results = []

async def simulate_user(session, user_id, token=None):
    """模拟单个用户的对弈请求"""
    moves = MOVE_SEQUENCES[user_id % len(MOVE_SEQUENCES)]
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    
    user_results = []
    for move_idx in range(MOVES_PER_USER):
        current_moves = moves * (move_idx + 1)  # 逐步增加落子
        payload = {
            "boardSize": 9,
            "difficulty": "hard",
            "engine": "katago",
            "moves": current_moves
        }
        
        start = time.time()
        try:
            async with session.post(
                f"{BASE_URL}/api/go-engine",
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=60)
            ) as resp:
                elapsed = time.time() - start
                status = resp.status
                data = await resp.json()
                engine_used = data.get("engine", "unknown")
                no_engine = data.get("noEngine", False)
                error = data.get("error", "")
                
        except asyncio.TimeoutError:
            elapsed = time.time() - start
            status = 0
            engine_used = "timeout"
            no_engine = False
            error = "timeout"
        except Exception as e:
            elapsed = time.time() - start
            status = -1
            engine_used = "error"
            no_engine = False
            error = str(e)[:50]
        
        result = {
            "user": user_id,
            "move": move_idx + 1,
            "status": status,
            "elapsed": round(elapsed, 2),
            "engine": engine_used,
            "noEngine": no_engine,
            "error": error
        }
        user_results.append(result)
        results.append(result)
        
        status_icon = "✅" if status == 200 else "❌"
        engine_info = engine_used if not no_engine else "local(fallback)"
        print(f"  用户{user_id:02d} 第{move_idx+1}步: {status_icon} {status} {elapsed:.1f}s [{engine_info}]")
        
        # 快速落子：不等太久就下下一步
        await asyncio.sleep(0.5)
    
    return user_results

async def check_queue(session):
    """持续监控排队状态"""
    for i in range(30):
        try:
            async with session.get(f"{BASE_URL}/api/go-engine", timeout=aiohttp.ClientTimeout(total=5)) as resp:
                data = await resp.json()
                q = data.get("queueLength", "?")
                p = data.get("isProcessing", "?")
                print(f"  📊 排队监控 #{i+1}: 排队人数={q} 处理中={p}")
        except:
            print(f"  📊 排队监控 #{i+1}: 获取失败")
        await asyncio.sleep(2)

async def main():
    print(f"=== KataGo 压力测试 ===")
    print(f"目标: {BASE_URL}")
    print(f"并发用户: {CONCURRENT_USERS}")
    print(f"每用户步数: {MOVES_PER_USER}")
    print()
    
    async with aiohttp.ClientSession() as session:
        # 注册测试用户获取token
        tokens = []
        for i in range(CONCURRENT_USERS):
            nickname = f"stresstest_{i:02d}"
            password = f"stress{i:02d}pass"
            try:
                async with session.post(
                    f"{BASE_URL}/api/auth/register",
                    json={"nickname": nickname, "password": password},
                    timeout=aiohttp.ClientTimeout(total=10)
                ) as resp:
                    data = await resp.json()
                    token = data.get("token", "")
                    if not token:
                        # 可能已注册，尝试登录
                        async with session.post(
                            f"{BASE_URL}/api/auth/login",
                            json={"nickname": nickname, "password": password},
                            timeout=aiohttp.ClientTimeout(total=10)
                        ) as resp2:
                            data2 = await resp2.json()
                            token = data2.get("token", "")
                    tokens.append(token)
            except Exception as e:
                tokens.append("")
                print(f"  注册用户{i:02d}失败: {e}")
        
        print(f"\n✅ 已准备 {sum(1 for t in tokens if t)} 个用户token\n")
        
        # 启动排队监控（后台）
        queue_task = asyncio.create_task(check_queue(session))
        
        # 同时启动所有用户
        print(f"🚀 开始压力测试 - {CONCURRENT_USERS}个用户同时请求KataGo...\n")
        start_time = time.time()
        
        tasks = [
            simulate_user(session, i, tokens[i] if i < len(tokens) else None)
            for i in range(CONCURRENT_USERS)
        ]
        await asyncio.gather(*tasks)
        
        total_time = time.time() - start_time
        queue_task.cancel()
        
        # 统计结果
        print(f"\n=== 压力测试结果 ===")
        print(f"总耗时: {total_time:.1f}s")
        print(f"总请求数: {len(results)}")
        
        success = [r for r in results if r["status"] == 200]
        failed = [r for r in results if r["status"] != 200]
        katago_used = [r for r in success if r["engine"] == "katago"]
        fallback = [r for r in success if r["noEngine"]]
        
        print(f"成功: {len(success)}  失败: {len(failed)}")
        print(f"KataGo处理: {len(katago_used)}  回退本地AI: {len(fallback)}")
        
        if success:
            times = [r["elapsed"] for r in success]
            print(f"响应时间: 最快{min(times):.1f}s  最慢{max(times):.1f}s  平均{sum(times)/len(times):.1f}s")
        
        if failed:
            print(f"\n失败请求:")
            for r in failed[:10]:
                print(f"  用户{r['user']:02d} 第{r['move']}步: status={r['status']} error={r['error']}")

if __name__ == "__main__":
    asyncio.run(main())
