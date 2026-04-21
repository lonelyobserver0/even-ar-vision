# AR Vision for Even Realities G2

An Augmented Reality plugin for Even Realities G2 smart glasses that uses the phone's camera to analyze the surrounding environment and display contextual information on the glasses display.

## Features

- **Camera Access**: Uses the phone's rear camera to capture the user's environment
- **AI Scene Analysis**: Analyzes captured images using LM Studio or OpenAI-compatible APIs to detect objects and scenes
- **Real-time Streaming**: Continuous frame capture and analysis every 2 seconds
- **Voice Chat**: Talk to the AI using glasses built-in transcription or text input
- **Glasses Display**: Shows analysis results and AI responses on the 576x288 pixel micro-LED display of G2 glasses
- **Event Handling**: Responds to touchpad interactions (click, double-click, scroll)
- **Web Preview**: Companion web UI for phone with camera feed, analysis results, and chat interface
- **Flexible AI Configuration**: Support for LM Studio (local) or OpenAI-compatible APIs with API keys

## Use Case

The app is designed for a hands-free AR experience: **keep your smartphone in your shirt pocket** with the camera facing outward. This allows the phone to capture everything you see while the glasses display AI-generated contextual information about your environment.

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

### Image Analysis with AI

The app uses AI for image analysis and chat. You can configure it to use:
- **LM Studio** (local AI running on your computer)
- **OpenAI-compatible APIs** (with API key)

The plugin runs on your phone while the AI service runs on a remote computer or cloud.

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
   - **Important**: Set "Bind to" to `0.0.0.0` (not `127.0.0.1`) to allow Tailscale connections
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
   - **Important**: Set "Bind to" to `0.0.0.0` to allow remote connections
   - Note the port (default: 1234)
   - Copy the model name (shown in the model info)

5. **Configure the app on your phone**:
   - Open the app on your phone
   - In the "LM Studio Configuration" section:
     - **LM Studio IP**: Enter your computer's IP address (e.g., `192.168.1.100`)
     - **Port**: Enter the LM Studio port (default: `1234`)
     - **Model**: Enter the exact model name from LM Studio
     - **Use API Key**: Check if using OpenAI-compatible API
     - **API Key**: Enter your API key if required
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

### Voice Chat

The app supports voice interaction with the AI:
- **Glasses Transcription**: Uses the G2 glasses' built-in transcription capability
- **Text Input**: Type messages directly in the web UI
- **Chat History**: Maintains conversation context
- **Glasses Display**: AI responses are shown on the glasses display

To use voice chat:
1. Ensure glasses are connected via Even Hub SDK
2. Click "Start Voice" to activate glasses audio capture
3. Speak naturally - glasses will transcribe your speech
4. Transcribed text is sent to the AI for processing
5. AI response appears in chat and on glasses

### How it works

The app sends images and text to AI using the OpenAI-compatible API:
- **Image Analysis**: Captures frame from phone camera, converts to base64 JPEG, sends to AI via HTTP
- **Chat**: Sends text/voice input to AI, maintains conversation history
- **Authentication**: Optional Bearer token support for API key authentication
- **Response**: Parses JSON response and displays results on glasses

Configuration is saved to localStorage on your phone, so you only need to set it up once.

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
- Glasses display is 4-bit greyscale (green) with limited resolution
- Max 4 image containers + 8 other containers per page
- AI analysis requires network connection to LM Studio or compatible API
- Voice transcription requires glasses connection (not available in web-only mode)
- Streaming mode may drain battery faster

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
