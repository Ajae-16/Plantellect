FROM python:3.11-slim

WORKDIR /app

# System deps for TensorFlow + image processing
RUN apt-get update && apt-get install -y \
    libglib2.0-0 libsm6 libxext6 libxrender-dev libgl1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install CPU-only TensorFlow for inference
RUN pip install --no-cache-dir "tensorflow-cpu==2.17.0"

COPY . .

# Remove legacy empty file
RUN rm -f app.py

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]