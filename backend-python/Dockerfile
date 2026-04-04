# Use Python 3.10 as base image
FROM python:3.10-slim

# Set working directory inside container
WORKDIR /app

# Install system dependencies
# Required for PyAudio, OpenCV, and MediaPipe
RUN apt-get update && apt-get install -y \
    portaudio19-dev \
    python3-dev \
    gcc \
    g++ \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements file first (for better caching)
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . .

# Expose the port your app runs on
EXPOSE 8000

# Command to run the application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]