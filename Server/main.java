// Declare the package name for this Android app
package com.plantellect.mobile;

// Import Android's permission constants (e.g., CAMERA permission string)
import android.Manifest;
// Import AlertDialog class to show popup dialogs to the user
import android.app.AlertDialog;
// Import Intent class to launch other apps/activities (like the camera app)
import android.content.Intent;
// Import PackageManager to query installed apps and their capabilities
import android.content.pm.PackageManager;
// Import Bitmap class to hold image pixel data in memory
import android.graphics.Bitmap;
// Import Bundle to save/restore activity state across configuration changes
import android.os.Bundle;
// Import MediaStore constants for media-related intents (e.g., camera capture)
import android.provider.MediaStore;
// Import Menu class to create the overflow/burger menu
import android.view.Menu;
// Import MenuItem to handle individual menu item clicks
import android.view.MenuItem;
// Import ScaleGestureDetector to detect pinch-to-zoom gestures
import android.view.ScaleGestureDetector;
// Import ImageView widget to display images on the screen
import android.widget.ImageView;
// Import Toast class to show short temporary messages to the user
import android.widget.Toast;

// Import NonNull annotation to indicate a parameter/field must not be null
import androidx.annotation.NonNull;
// Import AppCompatActivity base class for modern Android activity features
import androidx.appcompat.app.AppCompatActivity;
// Import ActivityCompat for runtime permission helper methods
import androidx.core.app.ActivityCompat;
// Import ContextCompat for context-aware permission checks
import androidx.core.content.ContextCompat;

// MainActivity is the single entry-point screen of this Android app
// It extends AppCompatActivity to support modern UI features and backward compatibility
public class MainActivity extends AppCompatActivity {

    // Request code constant used to identify the camera capture result when it returns
    private static final int REQUEST_IMAGE_CAPTURE = 1;
    // Request code constant used to identify the camera permission request when it returns
    private static final int REQUEST_CAMERA_PERMISSION = 2;

    // ImageView UI component that will display the captured photo on screen
    private ImageView imageView;
    // Bitmap variable to hold the captured image data in memory (not saved to disk)
    private Bitmap capturedBitmap;
    // Gesture detector object that listens for pinch-to-zoom touch gestures
    private ScaleGestureDetector scaleGestureDetector;
    // Floating-point variable tracking the current zoom scale level
    // Starts at 1.0f (100% zoom); 'f' suffix makes it a float literal
    private float scaleFactor = 1.0f;

    // onCreate is called when the Android system creates this Activity
    // savedInstanceState contains previously saved state if the app was destroyed and recreated
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Call the parent class's onCreate method to perform essential initialization
        super.onCreate(savedInstanceState);

        // Create a new ImageView instance programmatically (no XML layout file needed)
        imageView = new ImageView(this);
        // Set scale type so the image fits inside the view while maintaining aspect ratio
        imageView.setScaleType(ImageView.ScaleType.FIT_CENTER);
        // Set the background color of the view to black (0xFF000000) for contrast
        imageView.setBackgroundColor(0xFF000000);
        // Tell the Activity to display our ImageView as the main content view
        setContentView(imageView);

        // Create a ScaleGestureDetector to listen for two-finger pinch gestures
        // 'this' provides the context, new ScaleListener() provides the callback implementation
        scaleGestureDetector = new ScaleGestureDetector(this, new ScaleListener());
        // Set a touch listener on the ImageView so we can intercept all touch events
        // Lambda expression: (v, event) -> { ... } is shorthand for a one-method interface
        imageView.setOnTouchListener((v, event) -> {
            // Pass the touch event to the scale detector for processing
            scaleGestureDetector.onTouchEvent(event);
            // Return true to indicate we have consumed this touch event
            return true;
        });

        // Check whether the app already has permission to access the camera
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            // Camera permission is NOT granted; request it from the user
            ActivityCompat.requestPermissions(this,
                    // Pass an array containing the permission(s) we want
                    new String[]{Manifest.permission.CAMERA},
                    // Pass our request code constant so we can identify this request later
                    REQUEST_CAMERA_PERMISSION);
        } else {
            // Camera permission is already granted; go ahead and open the camera
            launchCamera();
        }
    }

    // Helper method to create and fire the camera intent
    private void launchCamera() {
        // Create a new Intent with the action "android.media.action.IMAGE_CAPTURE"
        // This tells Android we want to take a picture using any available camera app
        Intent takePictureIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        // Check if there is at least one app on the device that can handle this intent
        if (takePictureIntent.resolveActivity(getPackageManager()) != null) {
            // Start the camera app and wait for it to return a result
            // REQUEST_IMAGE_CAPTURE lets us identify this request in onActivityResult
            startActivityForResult(takePictureIntent, REQUEST_IMAGE_CAPTURE);
        } else {
            // No camera app found; inform the user with a short toast message
            Toast.makeText(this, "No camera app found", Toast.LENGTH_SHORT).show();
        }
    }

    // onActivityResult is called when the camera app finishes and returns to our app
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        // Verify this result is from our camera capture request AND the user didn't cancel
        if (requestCode == REQUEST_IMAGE_CAPTURE && resultCode == RESULT_OK && data != null) {
            // Extract the Bundle of extras from the returned Intent
            Bundle extras = data.getExtras();
            // Retrieve the image data from the "data" key (this is a small thumbnail Bitmap)
            capturedBitmap = (Bitmap) extras.get("data");

            // Check if we successfully received a Bitmap object
            if (capturedBitmap != null) {
                // Display the captured image inside our ImageView
                imageView.setImageBitmap(capturedBitmap);
                // Show a short confirmation message at the bottom of the screen
                Toast.makeText(this, "Photo captured", Toast.LENGTH_SHORT).show();
            } else {
                // Bitmap was null; something went wrong during capture
                Toast.makeText(this, "Failed to capture image", Toast.LENGTH_SHORT).show();
            }
        }
        // Always call the parent class's onActivityResult to ensure proper lifecycle behavior
        super.onActivityResult(requestCode, resultCode, data);
    }

    // onRequestPermissionsResult is called after the user responds to a permission request
    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        // Check if this response matches our camera permission request
        if (requestCode == REQUEST_CAMERA_PERMISSION) {
            // Verify the grantResults array is not empty AND the first permission was granted
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                // Permission granted; we can now safely launch the camera
                launchCamera();
            } else {
                // Permission denied; inform the user it is required
                Toast.makeText(this, "Camera permission required", Toast.LENGTH_LONG).show();
                // Close the app since we cannot function without camera access
                finish();
            }
        }
        // Call the parent implementation to maintain proper permission handling chain
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    // onCreateOptionsMenu is called when the Activity needs to display the overflow/burger menu
    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        // Add a new menu item to the menu with:
        // - No group ID (Menu.NONE)
        // - Unique item ID 1
        // - No order preference (Menu.NONE)
        // - Display text "Image Info"
        menu.add(Menu.NONE, 1, Menu.NONE, "Image Info")
                // Set this item to appear in the overflow menu (not directly in the action bar)
                .setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER);
        // Return true to indicate the menu was created successfully
        return true;
    }

    // onOptionsItemSelected is called when the user taps a menu item
    @Override
    public boolean onOptionsItemSelected(@NonNull MenuItem item) {
        // Check if the tapped item's ID matches our "Image Info" menu item ID
        if (item.getItemId() == 1) {
            // Call our custom method to display the image metadata dialog
            showImageMetadata();
            // Return true to indicate we handled this menu item click
            return true;
        }
        // For any other menu items, let the parent class handle them (e.g., back button)
        return super.onOptionsItemSelected(item);
    }

    // showImageMetadata builds and displays an AlertDialog with image resolution and size
    private void showImageMetadata() {
        // Only show metadata if an image has actually been captured
        if (capturedBitmap != null) {
            // Get the width of the captured image in pixels
            int width = capturedBitmap.getWidth();
            // Get the height of the captured image in pixels
            int height = capturedBitmap.getHeight();
            // Get the total number of bytes the Bitmap occupies in memory
            int byteCount = capturedBitmap.getByteCount();
            // Build a human-readable resolution string (e.g., "1920 x 1080 pixels")
            String resolution = width + " x " + height + " pixels";
            // Convert byte count to KB and format to 2 decimal places (e.g., "256.00 KB")
            String memory = String.format("%.2f KB", byteCount / 1024.0);

            // Create a new AlertDialog using the current Activity context
            new AlertDialog.Builder(this)
                    // Set the title text shown at the top of the dialog
                    .setTitle("Image Metadata")
                    // Set the main message content (resolution and file size)
                    .setMessage("Resolution: " + resolution + "\nSize: " + memory)
                    // Add a positive "OK" button that dismisses the dialog when tapped
                    .setPositiveButton("OK", null)
                    // Build and display the dialog on screen
                    .show();
        } else {
            // No image has been captured yet; inform the user with a toast
            Toast.makeText(this, "No image captured yet", Toast.LENGTH_SHORT).show();
        }
    }

    // onDestroy is called when the Activity is being permanently destroyed (e.g., app closed)
    @Override
    protected void onDestroy() {
        // Check if we still have a Bitmap and it hasn't already been recycled
        if (capturedBitmap != null && !capturedBitmap.isRecycled()) {
            // Recycle the Bitmap to free native memory immediately (important for Android)
            capturedBitmap.recycle();
        }
        // Call the parent class's onDestroy to complete cleanup
        super.onDestroy();
    }

    // ScaleListener handles pinch-to-zoom gesture events for the ImageView
    // It extends SimpleOnScaleGestureListener to receive scale change callbacks
    private class ScaleListener extends ScaleGestureDetector.SimpleOnScaleGestureListener {
        // onScale is called continuously while the user performs a pinch gesture
        @Override
        public boolean onScale(ScaleGestureDetector detector) {
            // Get the scale factor since the last gesture event (e.g., 1.05 for zoom in)
            scaleFactor *= detector.getScaleFactor();
            // Clamp the scale factor between 0.5x (half size) and 5.0x (5 times larger)
            scaleFactor = Math.max(0.5f, Math.min(scaleFactor, 5.0f));
            // Apply the scale factor to the ImageView's X-axis scale
            imageView.setScaleX(scaleFactor);
            // Apply the scale factor to the ImageView's Y-axis scale
            imageView.setScaleY(scaleFactor);
            // Return true to indicate we consumed this scale event
            return true;
        }
    }
}
