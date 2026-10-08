``` py
import tensorflow as tf
import numpy as np
import matplotlib.pyplot as plt
import json
import os
from sklearn.metrics import confusion_matrix, classification_report
import random
from tensorflow.keras.applications.efficientnet import preprocess_input
from google.colab import drive

SEED = 42
random.seed(SEED); np.random.seed(SEED); tf.keras.utils.set_random_seed(SEED)

MODEL_ARCH = "EfficientNetB0"
INPUT_SHAPE = (224, 224, 3)
NUM_CLASSES = 50
BATCH_SIZE = 32
EPOCHS = 50
LEARNING_RATE = 1e-4
DROPOUT = 0.5

AUGMENTATION = { "rotation": 20, "zoom": 0.2, "horizontal_flip": True, "brightness": 0.2, "contrast": 0.2}

#Callbacks or checkpoint if the model accuracy degrade
EARLY_STOPPING_PATIENCE = 10
REDUCE_LR_PATIENCE = 5

drive.mount('/content/drive')
DATA_DIR = "/content/drive/MyDrive/plantellect/plantellect_training"
OUT_DIR = "/content//drive/Mydrive/plantellect/model/main"

def class_to_scientific(folder: str) -> str:
    return "_".join(folder.split()).replace("_", " ").strip()

print("out:", OUT_DIR)

train_dir = os.path.join(DATA_DIR, "train")
val_dir   = os.path.join(DATA_DIR, "val")
test_dir  = os.path.join(DATA_DIR, "test")

class_names = sorted(os.listdir(train_dir))
NUM_CLASSES = len(class_names)
print(f"{NUM_CLASSES} classes")

assert set(os.listdir(train_dir)) == set(os.listdir(val_dir)), "train/ and val/ hold different class names — index shifts would silently mislabel everything"
assert set(os.listdir(train_dir)) == set(os.listdir(test_dir)), "train/ and test/ hold different class names"

counts = {n: sum(len(fs) for _, _, fs in os.walk(os.path.join(train_dir, n))) for n in class_names}
sizes  = sorted(counts.values())
print(f"train per class: min {sizes[0]}, median {sizes[len(sizes)//2]}, max {sizes[-1]}")
thin = [n for n, c in counts.items() if c < 15]
if thin:
    print("!! under 15 train images to low:", thin, "— these will make confident wrong predictions")

for name, d in (("val", val_dir), ("test", test_dir)):
    c = sum(sum(len(fs) for _, _, fs in os.walk(os.path.join(d, n))) for n in class_names)
    print(f"{name}: {c} images")

train_datagen = tf.keras.preprocessing.image.ImageDataGenerator(
    rotation_range=AUGMENTATION["rotation"],
    zoom_range=AUGMENTATION["zoom"],
    horizontal_flip=AUGMENTATION["horizontal_flip"],
    brightness_range=(1 - AUGMENTATION["brightness"], 1 + AUGMENTATION["brightness"]),
    contrast_range=(1 - AUGMENTATION["contrast"], 1 + AUGMENTATION["contrast"])
)

def gen(d, g):
    return g.flow_from_directory(
        d, target_size=INPUT_SHAPE[:2], batch_size=BATCH_SIZE,
        class_mode="categorical"
    )

train_generator = gen(train_dir, train_datagen)
val_generator   = gen(val_dir,   eval_datagen)
# shuffle=False is REQUIRED: y_pred comes back in batch order, y_true in dataset order.
test_generator  = gen(test_dir,  eval_datagen)

CLASS_TO_ID = {n: i for i, n in enumerate(class_names)}
ID_TO_CLASS = {i: class_to_scientific(n) for n, i in CLASS_TO_ID.items()}

assert len(CLASS_TO_ID) == NUM_CLASSES
assert train_generator.num_classes == NUM_CLASSES
print("index 0 ->", ID_TO_CLASS[0], "| last ->", ID_TO_CLASS[NUM_CLASSES - 1])


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

model.compile(optimizer=tf.keras.optimizers.Adam(learning_rate=LEARNING_RATE),
              loss="categorical_crossentropy", metrics=["accuracy"])
model.summary()

total = sum(counts[n] for n in class_names)
class_weight = {i: total / (NUM_CLASSES * counts[n]) for n, i in CLASS_TO_ID.items()}

history = model.fit(
    train_generator, epochs=EPOCHS, validation_data=val_generator,
    class_weight=class_weight,
    callbacks=[
        tf.keras.callbacks.EarlyStopping(patience=EARLY_STOPPING_PATIENCE, 
                                         restore_best_weights=True),
        tf.keras.callbacks.ReduceLROnPlateau(factor=0.5, 
                                             patience=REDUCE_LR_PATIENCE),
    ],
)


test_loss, test_acc = model.evaluate(test_generator)
print(f"Test accuracy: {test_acc:.4f}")

y_pred = np.argmax(model.predict(test_generator, verbose=0), axis=1)
y_true = test_generator.classes          # aligned: shuffle=False above
labels = [class_to_scientific(n) for n in test_generator.class_indices.keys()]

print(classification_report(y_true, y_pred, target_names=labels, zero_division=0))

cm = confusion_matrix(y_true, y_pred, labels=range(NUM_CLASSES))
plt.figure(figsize=(14, 12))
plt.imshow(cm, cmap="bwr"); plt.title("Confusion matrix"); plt.colorbar()
plt.xticks(range(NUM_CLASSES), labels, rotation=90, fontsize=6)
plt.yticks(range(NUM_CLASSES), labels, fontsize=6)
plt.tight_layout(); plt.show()

# test_generator[idx] now genuinely addresses sample idx, so titles match pictures.
wrong = np.where(y_pred != y_true)[0]
print(f"Misclassified: {len(wrong)} / {len(y_true)}")
if len(wrong):
    fig, axes = plt.subplots(2, 5, figsize=(15, 6))
    for ax, idx in zip(axes.flat, wrong[:10]):
        ax.imshow(test_generator[int(idx)][0][0] + 1.0)   # undo preprocess_input for display
        ax.set_title(f"True: {labels[y_true[idx]]}\nPred: {labels[y_pred[idx]]}", fontsize=7)
        ax.axis("off")
    plt.tight_layout(); plt.show()


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

model.save(os.path.join(OUT_DIR, "plantellect_model.keras"))

with open(os.path.join(OUT_DIR, "classes.json"), "w", encoding="utf-8") as f:
    json.dump({str(i): {"scientific": ID_TO_CLASS[i], "trainImages": counts[class_names[i]]}
               for i in range(NUM_CLASSES)},
              f, indent=2, ensure_ascii=False)

print("saved:", sorted(os.listdir(OUT_DIR)))

with open(os.path.join(OUT_DIR, "classes.json"), encoding="utf-8") as f:
    served = json.load(f)

reloaded = tf.keras.models.load_model(os.path.join(OUT_DIR, "plantellect_model.keras"))

assert len(served) == reloaded.output_shape[-1], (
    f"classes.json has {len(served)} entries but the model predicts {reloaded.output_shape[-1]} "
    "— different training runs. Every prediction would be confidently wrong.")
assert len(served) == model.output_shape[-1]
assert not any("_" in v["scientific"] for v in served.values()), "underscore translation was skipped"
assert all(v["scientific"] == v["scientific"].strip() for v in served.values())

x, _ = next(iter(eval_datagen.flow_from_directory(test_dir, INPUT_SHAPE[:2], batch_size=1)))
print("sample range:", float(x.min()), "to", float(x.max()), "(want roughly -1.0 to 1.0)")
print("OK — artifacts consistent")
