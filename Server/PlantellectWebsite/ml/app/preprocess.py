import numpy as np
from PIL import Image
import io

INPUT_SHAPE = (224, 224, 3)

def preprocess_image(image_bytes: bytes) -> np.ndarray:
    """
    Preprocess image bytes for model inference.
    
    Args:
        image_bytes: Raw image bytes
        
    Returns:
        Preprocessed image as numpy array with shape (1, 224, 224, 3), values in [0, 1]
    """
    try:
        img = Image.open(io.BytesIO(image_bytes))
    except Exception as e:
        raise ValueError(f"Invalid image: {str(e)}")
    
    # Convert to RGB if needed (handles RGBA, grayscale, etc.)
    if img.mode != "RGB":
        img = img.convert("RGB")
    
    # Resize to model input size
    img = img.resize((INPUT_SHAPE[0], INPUT_SHAPE[1]), Image.Resampling.LANCZOS)
    
    # Convert to numpy array and normalize to [0, 1]
    img_array = np.array(img, dtype=np.float32) / 255.0
    
    # Add batch dimension: (224, 224, 3) -> (1, 224, 224, 3)
    img_array = np.expand_dims(img_array, axis=0)
    
    return img_array

def preprocess_image_from_path(image_path: str) -> np.ndarray:
    """
    Preprocess image from file path for model inference.
    
    Args:
        image_path: Path to image file
        
    Returns:
        Preprocessed image as numpy array with shape (1, 224, 224, 3), values in [0, 1]
    """
    try:
        img = Image.open(image_path)
    except Exception as e:
        raise ValueError(f"Invalid image at {image_path}: {str(e)}")
    
    if img.mode != "RGB":
        img = img.convert("RGB")
    
    img = img.resize((INPUT_SHAPE[0], INPUT_SHAPE[1]), Image.Resampling.LANCZOS)
    img_array = np.array(img, dtype=np.float32) / 255.0
    img_array = np.expand_dims(img_array, axis=0)
    
    return img_array