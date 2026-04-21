# AR Vision for Even Realities G2

An Augmented Reality plugin for Even Realities G2 smart glasses that uses the phone's camera to analyze the surrounding environment and display contextual information on the glasses display.

## Features

- **Camera Access**: Uses the phone's rear camera to capture the user's environment
- **Scene Analysis**: Analyzes captured images to detect objects and scenes (currently uses mock data, ready for AI integration)
- **Glasses Display**: Shows analysis results on the 576x288 pixel micro-LED display of G2 glasses
- **Event Handling**: Responds to touchpad interactions (click, double-click, scroll)
- **Web Preview**: Companion web UI for phone with camera feed and analysis results

## Architecture

The app follows the Even Hub architecture:
- **Phone**: Runs the web app, handles camera access, image processing, and AI analysis
- **Glasses**: Displays formatted analysis results via the Even Hub SDK bridge
- **Communication**: Bluetooth connection between phone and glasses via Even Realities App

## Prerequisites

- Node.js v18+
- Even Realities G2 glasses (or simulator for testing)
- Even Realities App installed on phone
- Phone with camera support

## Installation

1. **Install dependencies**:
```bash
npm install
```

2. **Install Even Hub tools** (for development and deployment):
```bash
npm install -g @evenrealities/evenhub-simulator
npm install -D @evenrealities/evenhub-cli
```

## Development

### Run locally (web-only mode)
```bash
npm run dev
```
Open http://localhost:5173 in your browser. The app will run in web-only mode without glasses connection.

### Run with simulator
```bash
# Terminal 1: Start dev server
npm run dev

# Terminal 2: Start simulator
evenhub-simulator http://localhost:5173
```

### Test on real hardware
```bash
# Start dev server
npm run dev

# Generate QR code for sideloading
evenhub qr --url "http://YOUR_LOCAL_IP:5173"
```
Scan the QR code with the Even Realities App on your phone.

## Project Structure

```
even-ar-vision/
├── src/
│   ├── main.ts          # Main application logic
│   ├── style.css        # UI styling
│   └── assets/          # Static assets
├── public/              # Public files
├── app.json             # Even Hub manifest
├── package.json         # Dependencies
├── tsconfig.json        # TypeScript config
└── vite.config.ts       # Vite build config
```

## Key Components

### ARVisionApp Class
Main application class that handles:
- Camera initialization and stream management
- SDK bridge initialization
- Image capture and analysis
- UI updates
- Glasses display communication

### Image Analysis with LM Studio

The app is configured to use **LM Studio** for AI analysis. The plugin runs on your phone while LM Studio runs on a remote computer (your PC).

### Setting up LM Studio on Remote Computer

**Option 1: Using Tailscale VPN (Recommended)**

Tailscale creates a secure private network between your devices, making remote access simple without router configuration.

1. **Install Tailscale on both devices**:
   - **Computer**: Download from [tailscale.com](https://tailscale.com)
   - **Phone**: Install Tailscale app from App Store/Google Play
   - Log in with the same account on both devices

2. **Find your computer's Tailscale IP**:
   - On computer: Open Tailscale app, note the IP address (typically 100.x.x.x)
   - Or run: `tailscale ip -4`

3. **Enable LM Studio API server**:
   - Open LM Studio, go to "Server" tab
   - Enable "Server Mode"
   - Note the port (default: 1234)
   - Copy the model name

4. **Configure the app**:
   - Open app on phone
   - In "LM Studio Configuration":
     - **LM Studio IP**: Enter Tailscale IP (e.g., `100.x.x.x`)
     - **Port**: `1234`
     - **Model**: Model name from LM Studio
   - Click "Save Configuration"

5. **Test connection**:
   - Start camera
   - Click "Analyze Single Frame"
   - Should work regardless of network location

**Option 2: Same Wi-Fi Network**

1. **Download and install LM Studio** from [lmstudio.ai](https://lmstudio.ai) on your computer

2. **Download a vision-capable model**:
   - Open LM Studio
   - Search for vision models (e.g., "llava", "bakllava", "minicpm-v")
   - Download and load the model

3. **Find your computer's IP address**:
   - **Windows**: Open Command Prompt, run `ipconfig`, look for "IPv4 Address"
   - **macOS**: Open Terminal, run `ifconfig` or check System Preferences > Network
   - **Linux**: Open Terminal, run `ip addr` or `hostname -I`
   - Note the IP (e.g., `192.168.1.100`)

4. **Enable the API server for remote access**:
   - In LM Studio, go to the "Server" tab
   - Enable "Server Mode"
   - Note the port (default: 1234)
   - **Important**: LM Studio typically binds to localhost by default. You may need to:
     - Check LM Studio settings for "Allow network connections" or similar option
     - Or use a proxy/SSH tunnel if direct access is blocked
   - Copy the model name (shown in the model info)

5. **Configure the app on your phone**:
   - Open the app on your phone
   - In the "LM Studio Configuration" section:
     - **LM Studio IP**: Enter your computer's IP address (e.g., `192.168.1.100`)
     - **Port**: Enter the LM Studio port (default: `1234`)
     - **Model**: Enter the exact model name from LM Studio
   - Click "Save Configuration"

6. **Ensure both devices are on the same network**:
   - Your phone and computer must be connected to the same Wi-Fi network
   - If using different networks, you'll need port forwarding or VPN

7. **Test the connection**:
   - Start the camera
   - Click "Analyze Single Frame"
   - Check the status for connection errors

### Troubleshooting Remote Connection

**Connection refused/timeout:**
- Verify LM Studio is running on your computer
- Check firewall settings on your computer (allow port 1234)
- Ensure phone and computer are on same network
- Try pinging the computer IP from your phone (if possible)

**LM Studio not accepting remote connections:**
- LM Studio may bind to localhost only by default
- Check LM Studio documentation for network access settings
- Consider using SSH tunneling: `ssh -L 1234:localhost:1234 user@remote-pc`
- Or use a reverse proxy like ngrok for testing

### How it works

The app sends images to LM Studio using the OpenAI-compatible chat completions API with vision support:
- Captures frame from phone camera
- Converts to base64 JPEG
- Sends to remote LM Studio via HTTP
- Parses JSON response with scene, objects, and confidence
- Displays results on glasses

Configuration is saved to localStorage on your phone, so you only need to set it up once.

### Alternative AI Services

To use a different AI service, modify the `performImageAnalysis` method in `src/main.ts`:

### Glasses Display
Analysis results are formatted for the 576x288 pixel display:
- 4-bit greyscale (rendered as green on hardware)
- Max ~400-500 characters per screen
- Uses Unicode box-drawing characters for visual structure
- Native scrolling when content exceeds screen height

## Permissions

The app requires the following permissions (configured in `app.json`):
- `camera`: Access phone camera for environment capture
- `network`: Send images to AI services for analysis

## Building for Distribution

1. **Build the web app**:
```bash
npm run build
```

2. **Package for Even Hub**:
```bash
evenhub pack app.json dist -o ar-vision.ehpk
```

3. **Upload to Even Hub**:
Upload the `.ehpk` file to the Even Hub developer portal for distribution.

## Event Handling

The app responds to the following glasses inputs:
- **Click**: Trigger action
- **Double-click**: Secondary action
- **Scroll up/down**: Navigate content

Extend the `handleUserAction` method to implement custom interactions.

## Limitations

- Camera access only works on phone (not on desktop browsers)
- Mock analysis returns static data - integrate AI service for production
- Glasses display is 4-bit greyscale (green) with limited resolution
- Max 4 image containers + 8 other containers per page

## Troubleshooting

**Camera not starting**: Ensure camera permissions are granted in the Even Realities App settings.

**SDK not connecting**: The app gracefully falls back to web-only mode if the bridge is unavailable (e.g., when testing in browser).

**Packaging errors**: Verify `app.json` fields match the required format and that the entrypoint file exists in the build directory.

## Resources

- [Even Hub Documentation](https://hub.evenrealities.com/docs/getting-started/overview)
- [Even Hub SDK](https://www.npmjs.com/package/@evenrealities/even_hub_sdk)
- [G2 Development Notes](https://github.com/nickustinov/even-g2-notes/blob/main/G2.md)
- [Even Toolkit](https://github.com/fabioglimb/even-toolkit)
- [Discord Community](https://discord.gg/Y4jHMCU4sv)

## License

This is a demonstration project for Even Realities G2 smart glasses.
