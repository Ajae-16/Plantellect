import tensorflow as tf
import numpy as np
from typing import List, Dict, Any

def load_model(model_path: str) -> tf.keras.Model:
    """
    Load the trained Keras model.
    
    Args:
        model_path: Path to the .keras model file
        
    Returns:
        Loaded Keras model
    """
    try:
        model = tf.keras.models.load_model(model_path)
        return model
    except Exception as e:
        raise RuntimeError(f"Failed to load model from {model_path}: {str(e)}")

def predict_image(
    model: tf.keras.Model,
    image: np.ndarray,
    class_names: Dict[str, Dict[str, str]],
    top_k: int = 5
) -> List[Dict[str, Any]]:
    """
    Run inference on a single preprocessed image.
    
    Args:
        model: Loaded Keras model
        image: Preprocessed image array with shape (1, 224, 224, 3)
        class_names: Dictionary mapping class indices to {scientific, common} names
        top_k: Number of top predictions to return
        
    Returns:
        List of prediction dictionaries sorted by confidence descending
    """
    # Run inference
    predictions = model.predict(image, verbose=0)[0]
    
    # Get top-k indices
    top_indices = np.argsort(predictions)[::-1][:top_k]
    
    # Build response
    results = []
    for idx in top_indices:
        class_id = int(idx)
        class_info = class_names.get(str(class_id), {"scientific": "Unknown", "common": "Unknown"})
        results.append({
            "class_id": class_id,
            "scientific_name": class_info.get("scientific", "Unknown"),
            "common_name": class_info.get("common", "Unknown"),
            "confidence": float(predictions[idx])
        })
    
    return results

def predict_batch(
    model: tf.keras.Model,
    images: List[np.ndarray],
    class_names: Dict[str, Dict[str, str]],
    top_k: int = 5
) -> List[List[Dict[str, Any]]]:
    """
    Run inference on a batch of preprocessed images.
    
    Args:
        model: Loaded Keras model
        images: List of preprocessed image arrays
        class_names: Dictionary mapping class indices to {scientific, common} names
        top_k: Number of top predictions to return per image
        
    Returns:
        List of prediction lists (one per image)
    """
    # Stack images into batch
    batch = np.vstack(images)
    
    # Run inference
    batch_predictions = model.predict(batch, verbose=0)
    
    # Process each image's predictions
    results = []
    for predictions in batch_predictions:
        top_indices = np.argsort(predictions)[::-1][:top_k]
        image_results = []
        for idx in top_indices:
            class_id = int(idx)
            class_info = class_names.get(str(class_id), {"scientific": "Unknown", "common": "Unknown"})
            image_results.append({
                "class_id": class_id,
                "scientific_name": class_info.get("scientific", "Unknown"),
                "common_name": class_info.get("common", "Unknown"),
                "confidence": float(predictions[idx])
            })
        results.append(image_results)
    
    return results

def get_model_info(model: tf.keras.Model, class_names: Dict[str, Dict[str, str]]) -> Dict[str, Any]:
    """
    Get model metadata.
    
    Args:
        model: Loaded Keras model
        class_names: Dictionary mapping class indices to {scientific, common} names
        
    Returns:
        Dictionary with model metadata
    """
    input_shape = model.input_shape
    if isinstance(input_shape, list):
        input_shape = input_shape[0]
    
    return {
        "model_version": "v1.0.0",
        "input_shape": list(input_shape) if input_shape else [None, 224, 224, 3],
        "num_classes": len(class_names),
        "classes": class_names
    }