#!/bin/bash
# FastAPI 服务启动脚本

set -e

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}======================================${NC}"
echo -e "${GREEN}  FinSagent API 启动脚本${NC}"
echo -e "${GREEN}======================================${NC}"

# 切换到项目根目录
cd "$(dirname "$0")/.."
PROJECT_ROOT=$(pwd)

echo -e "${YELLOW}项目根目录: ${PROJECT_ROOT}${NC}"

# 检查必要目录
if [ ! -d "pe_logs" ]; then
    echo -e "${YELLOW}创建日志目录...${NC}"
    mkdir -p pe_logs
fi

# 检查配置文件
if [ ! -f "config/production.yaml" ]; then
    echo -e "${RED}错误: 配置文件不存在: config/production.yaml${NC}"
    exit 1
fi

# 设置环境变量
export PYTHONPATH="${PROJECT_ROOT}/src:${PYTHONPATH}"

# 默认参数
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-6008}"
WORKERS="${WORKERS:-1}"

echo -e "${GREEN}启动参数:${NC}"
echo -e "  Host: ${HOST}"
echo -e "  Port: ${PORT}"
echo -e "  Workers: ${WORKERS}"

# 启动服务
echo -e "${GREEN}正在启动 FastAPI 服务...${NC}"

cd deploy

uvicorn app:app \
    --host ${HOST} \
    --port ${PORT} \
    --workers ${WORKERS} \
    --log-level info \
    --access-log \
    --loop asyncio

# 如果服务停止
echo -e "${YELLOW}服务已停止${NC}"
