package com.even.arvision;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int CAMERA_PERMISSION_CODE = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the embedded relay plugin before the bridge starts.
        registerPlugin(RelayServerPlugin.class);
        super.onCreate(savedInstanceState);

        // Request the camera runtime permission up front so getUserMedia (live preview)
        // works as soon as the user starts the camera. Capacitor's WebView then grants
        // the in-page getUserMedia request once this OS permission is held.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                    this, new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_CODE);
        }
    }
}
