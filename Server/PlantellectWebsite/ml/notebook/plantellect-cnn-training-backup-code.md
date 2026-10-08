# PLANTELLECT USED TRAINING ALGORITHM
``` python
import tensorflow as tf
import numpy as np
import matplotlib.pyplot as plt
import json
import os
from PIL import Image
from sklearn.model_selection import train_test_split
from sklearn.metrics import confusion_matrix, classification_report

MODEL_ARCH = "EfficientNetB0"
INPUT_SHAPE = (224, 224, 3)
NUM_CLASSES = 50
BATCH_SIZE = 32
EPOCHS = 50
LEARNING_RATE = 1e-4
DROPOUT = 0.2

AUGMENTATION = { "rotation": 20, "zoom": 0.2, "horizontal_flip": True, "brightness": 0.2, "contrast": 0.2}

#Callbacks or checkpoint if the model accuracy degrade
EARLY_STOPPING_PATIENCE = 10
REDUCE_LR_PATIENCE = 5
MODEL_CHECKPOINT_PATH = ""

from google.colab import drive
drive.mount('/content/drive')
data_dir = "/content/drive/MyDrive/plantellect images"

def build_model():
    base = tf.keras.applications.EfficientNetB0(
        include_top = False,
        weights = "imagenet",
        input_shape = INPUT_SHAPE,
        pooling = "avg"
    )

    base.trainable = False

    model = tf.keras.Sequential([
        base,
        tf.keras.layers.Dense(512, activation= "relu"),
        tf.keras.layers.Dropout (DROPOUT),
        tf.keras.layers.Dense (NUM_CLASSES, activation="softmax")
    ])

    return model

model = build_model()
model.compile(
    optimizer=tf.keras.optimizers.Adam(learning_rate=LEARNING_RATE),
    loss="categorical_crossentropy",
    metrics=["accuracy"]
)

#Augmentation
train_datagen = tf.keras.preprocessing.image.ImageDataGenerator(
    rotation_range=AUGMENTATION["rotation"],
    zoom_range=AUGMENTATION["zoom"],
    horizontal_flip=AUGMENTATION["horizontal_flip"],
    brightness_range=(1 - AUGMENTATION["brightness"], 1 + AUGMENTATION["brightness"]),
    rescale=1.0/255.0
)

val_datagen = tf.keras.preprocessing.image.ImageDataGenerator(rescale=1.0/255.0)

train_generator = train_datagen.flow_from_directory(
    os.path.join(data_dir, "train"),
    target_size=INPUT_SHAPE[:2],
    batch_size=BATCH_SIZE,
    class_mode="categorical"
)

val_generator = val_datagen.flow_from_directory(
    os.path.join(data_dir, "val"),
    target_size=INPUT_SHAPE[:2],
    batch_size=BATCH_SIZE,
    class_mode="categorical"
)

#Callbacks or checkpoint if the model accuracy degrade
callbacks = [
    tf.keras.callbacks.EarlyStopping(
        patience=EARLY_STOPPING_PATIENCE,
        restore_best_weights=True
    ),
    tf.keras.callbacks.ReduceLROnPlateau(
        factor=0.5,
        patience=REDUCE_LR_PATIENCE
    ),
    tf.keras.callbacks.ModelCheckpoint(
        MODEL_CHECKPOINT_PATH,
        save_best_only=True,
        monitor="val_accuracy"
    )
]

history = model.fit(
    train_generator,
    epochs=EPOCHS,
    validation_data=val_generator,
    callbacks=callbacks
)

test_generator = val_datagen.flow_from_directory(
    os.path.join(data_dir, "test"),
    target_size= INPUT_SHAPE[:2],
    batch_size = BATCH_SIZE,
    class_mode = "catergorical"
)

test_loss, test_acc = model.evaluate(test_generator)
print(f"Testing Accuracy: {test_acc:.4f}")

y_pred = np.argmax(model.predict(test_generator), axis=1)
y_true = test_generator.classes
print(classification_report(y_true, y_pred, target_names=list(test_generator.class_indices.keys())))

cm = confusion_matrix(y_true, y_pred)
plt.figure(figsize=(10,10))
plt.imshow(cm, cmap="bwr")
plt.title("confusion matrix")
plt.colorbar()
for y in range(len(cm)):
    for x in range(len(cm)):
        plt.text(x, y, str(cm[y, x]), ha="center", va="center")
plt.show

misclassified = np.where(y_pred != y_true)[0]
print(f"Misclassified: {len(misclassified)} / {len(y_true)}")

# Show first 10 misclassified images with predictions
fig, axes = plt.subplots(2, 5, figsize=(15, 6))
for i, idx in enumerate(misclassified[:10]):
    ax = axes[i // 5][i % 5]
    # Get the image (need to regenerate from test_generator)
    img = test_generator[idx][0][0]  # First image in the batch
    ax.imshow(img)
    ax.set_title(f"True: {list(test_generator.class_indices.keys())[y_true[idx]]}\n"
                 f"Pred: {list(test_generator.class_indices.keys())[y_pred[idx]]}")
    ax.axis("off")
plt.tight_layout()
plt.show()


fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))

# Loss plot
ax1.plot(history.history["loss"], label="Training Loss")
ax1.plot(history.history["val_loss"], label="Validation Loss")
ax1.set_title("Model Loss")
ax1.set_xlabel("Epoch")
ax1.set_ylabel("Loss")
ax1.legend()

# Accuracy plot
ax2.plot(history.history["accuracy"], label="Training Accuracy")
ax2.plot(history.history["val_accuracy"], label="Validation Accuracy")
ax2.set_title("Model Accuracy")
ax2.set_xlabel("Epoch")
ax2.set_ylabel("Accuracy")
ax2.legend()

plt.tight_layout()
plt.show()

with open("/content/classes.json", "w") as f:
    json.dump({str (v): {"scientific" : k, "common" : k}
               for k, v in train_generator.class_indices.items()}, f, indent = 2)

```
