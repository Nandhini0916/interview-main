# Use Python 3.10 as base image
FROM python:3.10-slim

# Set working directory inside container
WORKDIR /app

# Install system dependencies required for PyAudio, OpenCV, and MediaPipe
RUN apt-get update && apt-get install -y \
    portaudio19-dev \     # Required for PyAudio
    python3-dev \          # Python development headers
    gcc \                  # C compiler
    g++ \                  # C++ compiler
    libgl1-mesa-glx \      # Required for OpenCV
    libglib2.0-0 \         # Required for OpenCV
    libsm6 \               # Required for OpenCV
    libxext6 \             # Required for OpenCV
    libxrender-dev \       # Required for OpenCV
    libgomp1 \             # Required for MediaPipe
    wget \                 # Utility for downloading
    && rm -rf /var/lib/apt/lists/*  # Clean up to reduce image size

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