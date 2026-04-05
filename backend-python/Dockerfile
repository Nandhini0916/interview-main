FROM python:3.10-slim

WORKDIR /app

# Install only essential system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgomp1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Memory optimization environment variables
ENV TF_CPP_MIN_LOG_LEVEL=3
ENV OMP_NUM_THREADS=1

EXPOSE 10000

# Run with single worker to conserve memory
CMD uvicorn main:app --host 0.0.0.0 --port 10000 --workers 1 --limit-max-requests 100