FROM python:3.10-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    portaudio19-dev \
    python3-dev \
    gcc \
    g++ \
    libgl1 \
    libglib2.0-0t64 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgomp1 \
    wget \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

# Copy all files including the model
COPY . .

# Render's default external port is 10000
EXPOSE 10000

CMD uvicorn main:app --host 0.0.0.0 --port 10000