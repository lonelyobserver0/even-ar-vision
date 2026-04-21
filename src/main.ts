import './style.css'
import { waitForEvenAppBridge, TextContainerProperty, OsEventTypeList } from '@evenrealities/even_hub_sdk'

interface ARAnalysis {
  objects: string[]
  scene: string
  confidence: number
}

interface LMStudioConfig {
  baseUrl: string
  model: string
  maxTokens: number
  temperature: number
  apiKey?: string
  useApiKey: boolean
}

class ARVisionApp {
  private bridge: any = null
  private videoElement: HTMLVideoElement | null = null
  private canvasElement: HTMLCanvasElement | null = null
  private stream: MediaStream | null = null
  private analysisInterval: number | null = null
  private isStreaming = false
  private isAudioCapturing = false
  private chatHistory: Array<{role: string, content: string}> = []
  private lmStudioConfig: LMStudioConfig = {
    baseUrl: 'http://100.x.x.x:1234/v1', // IP Tailscale del computer dove gira LM Studio
    model: 'local-model', // Sostituisci con il nome del tuo modello in LM Studio
    maxTokens: 500,
    temperature: 0.7,
    useApiKey: false
  }

  constructor() {
    this.initializeUI()
  }

  private initializeUI() {
    const app = document.querySelector<HTMLDivElement>('#app')!
    app.innerHTML = `
      <div class="ar-container">
        <h1>AR Vision</h1>
        <p>Camera-based environment analysis for Even G2 glasses</p>
        
        <div class="camera-section">
          <video id="camera" autoplay playsinline muted></video>
          <canvas id="capture" style="display:none;"></canvas>
        </div>
        
        <div class="controls">
          <button id="startCamera" class="btn btn-primary">Start Camera</button>
          <button id="stopCamera" class="btn btn-secondary" disabled>Stop Camera</button>
          <button id="startStreaming" class="btn btn-accent" disabled>Start Streaming</button>
          <button id="stopStreaming" class="btn btn-secondary" disabled>Stop Streaming</button>
          <button id="analyze" class="btn btn-accent" disabled>Analyze Single Frame</button>
        </div>

        <div class="config-section">
          <h3>LM Studio Configuration</h3>
          <div class="config-item">
            <label for="lmStudioIp">LM Studio IP:</label>
            <input type="text" id="lmStudioIp" value="192.168.1.100" placeholder="192.168.1.100">
          </div>
          <div class="config-item">
            <label for="lmStudioPort">Port:</label>
            <input type="text" id="lmStudioPort" value="1234" placeholder="1234">
          </div>
          <div class="config-item">
            <label for="lmStudioModel">Model:</label>
            <input type="text" id="lmStudioModel" value="local-model" placeholder="model-name">
          </div>
          <div class="config-item">
            <label for="useApiKey">Use API Key:</label>
            <input type="checkbox" id="useApiKey">
          </div>
          <div class="config-item">
            <label for="apiKey">API Key (OpenAI-compatible):</label>
            <input type="password" id="apiKey" placeholder="sk-..." autocomplete="off">
          </div>
          <button id="saveConfig" class="btn btn-secondary">Save Configuration</button>
        </div>

        <div class="chat-section">
          <h3>Voice Chat with AI</h3>
          <div class="chat-controls">
            <button id="startVoice" class="btn btn-primary">🎤 Start Voice</button>
            <button id="stopVoice" class="btn btn-secondary" disabled>⏹️ Stop Voice</button>
          </div>
          <div class="chat-status">
            <p id="voiceStatus">Click "Start Voice" to begin speaking</p>
          </div>
          <div class="chat-history" id="chatHistory">
            <p class="chat-placeholder">Chat history will appear here...</p>
          </div>
          <div class="chat-input">
            <input type="text" id="textInput" placeholder="Or type your message here...">
            <button id="sendText" class="btn btn-accent">Send</button>
          </div>
        </div>
        
        <div class="status">
          <p id="status">Ready to start</p>
        </div>
        
        <div class="analysis-result">
          <h3>Analysis Results</h3>
          <div id="results">
            <p>No analysis yet</p>
          </div>
        </div>
        
        <div class="glasses-preview">
          <h3>Glasses Display Preview</h3>
          <div id="glassesDisplay" class="glasses-display">
            <p>Waiting for data...</p>
          </div>
        </div>
      </div>
    `

    this.videoElement = document.querySelector<HTMLVideoElement>('#camera')!
    this.canvasElement = document.querySelector<HTMLCanvasElement>('#capture')!

    document.querySelector<HTMLButtonElement>('#startCamera')!.addEventListener('click', () => this.startCamera())
    document.querySelector<HTMLButtonElement>('#stopCamera')!.addEventListener('click', () => this.stopCamera())
    document.querySelector<HTMLButtonElement>('#startStreaming')!.addEventListener('click', () => this.startStreaming())
    document.querySelector<HTMLButtonElement>('#stopStreaming')!.addEventListener('click', () => this.stopStreaming())
    document.querySelector<HTMLButtonElement>('#analyze')!.addEventListener('click', () => this.analyzeScene())
    document.querySelector<HTMLButtonElement>('#saveConfig')!.addEventListener('click', () => this.saveConfig())
    document.querySelector<HTMLButtonElement>('#startVoice')!.addEventListener('click', () => this.startGlassesAudio())
    document.querySelector<HTMLButtonElement>('#stopVoice')!.addEventListener('click', () => this.stopGlassesAudio())
    document.querySelector<HTMLButtonElement>('#sendText')!.addEventListener('click', () => this.sendTextMessage())
    document.querySelector<HTMLInputElement>('#textInput')!.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.sendTextMessage()
    })

    this.loadConfig()
    this.initializeSDK()
  }

  private async initializeSDK() {
    try {
      this.bridge = await waitForEvenAppBridge()
      this.updateStatus('SDK connected. Ready for glasses.')
      this.setupEventHandlers()
    } catch (error) {
      console.error('Failed to initialize SDK:', error)
      this.updateStatus('SDK not connected. Running in web-only mode.')
    }
  }

  private setupEventHandlers() {
    if (!this.bridge) return

    this.bridge.onEvenHubEvent((event: any) => {
      const textEvent = event.textEvent
      if (textEvent) {
        const eventType = textEvent.eventType
        switch (eventType) {
          case OsEventTypeList.CLICK_EVENT:
          case undefined:
            this.handleUserAction('click')
            break
          case OsEventTypeList.DOUBLE_CLICK_EVENT:
            this.handleUserAction('double-click')
            break
          case OsEventTypeList.SCROLL_TOP_EVENT:
            this.handleUserAction('scroll-up')
            break
          case OsEventTypeList.SCROLL_BOTTOM_EVENT:
            this.handleUserAction('scroll-down')
            break
        }
      }

      // Handle audio events from glasses
      const audioEvent = event.audioEvent
      if (audioEvent && this.isAudioCapturing) {
        this.handleGlassesAudio(audioEvent)
      }
    })
  }

  private handleUserAction(action: string) {
    console.log('User action on glasses:', action)
    // Implement action handling based on user interaction
  }

  private async startCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false
      })
      
      if (this.videoElement) {
        this.videoElement.srcObject = this.stream
      }
      
      document.querySelector<HTMLButtonElement>('#startCamera')!.disabled = true
      document.querySelector<HTMLButtonElement>('#stopCamera')!.disabled = false
      document.querySelector<HTMLButtonElement>('#startStreaming')!.disabled = false
      document.querySelector<HTMLButtonElement>('#analyze')!.disabled = false
      
      this.updateStatus('Camera started. Ready to analyze.')
    } catch (error) {
      console.error('Error accessing camera:', error)
      this.updateStatus('Error: Could not access camera. Check permissions.')
    }
  }

  private stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop())
      this.stream = null
    }
    
    if (this.videoElement) {
      this.videoElement.srcObject = null
    }
    
    document.querySelector<HTMLButtonElement>('#startCamera')!.disabled = false
    document.querySelector<HTMLButtonElement>('#stopCamera')!.disabled = true
    document.querySelector<HTMLButtonElement>('#startStreaming')!.disabled = true
    document.querySelector<HTMLButtonElement>('#stopStreaming')!.disabled = true
    document.querySelector<HTMLButtonElement>('#analyze')!.disabled = true

    // Stop streaming if active
    if (this.isStreaming) {
      this.stopStreaming()
    }

    this.updateStatus('Camera stopped.')
  }

  private startStreaming() {
    if (!this.videoElement || !this.canvasElement || this.isStreaming) return

    this.isStreaming = true
    this.updateStatus('Streaming analysis started...')

    // Capture and analyze frames every 2 seconds
    this.analysisInterval = window.setInterval(async () => {
      await this.captureAndAnalyzeFrame()
    }, 2000)

    document.querySelector<HTMLButtonElement>('#startStreaming')!.disabled = true
    document.querySelector<HTMLButtonElement>('#stopStreaming')!.disabled = false
    document.querySelector<HTMLButtonElement>('#analyze')!.disabled = true
  }

  private stopStreaming() {
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval)
      this.analysisInterval = null
    }
    this.isStreaming = false
    this.updateStatus('Streaming stopped.')

    document.querySelector<HTMLButtonElement>('#startStreaming')!.disabled = false
    document.querySelector<HTMLButtonElement>('#stopStreaming')!.disabled = true
    document.querySelector<HTMLButtonElement>('#analyze')!.disabled = false
  }

  private async captureAndAnalyzeFrame() {
    if (!this.videoElement || !this.canvasElement) return

    // Capture frame
    this.canvasElement.width = this.videoElement.videoWidth
    this.canvasElement.height = this.videoElement.videoHeight
    const ctx = this.canvasElement.getContext('2d')
    if (!ctx) return

    ctx.drawImage(this.videoElement, 0, 0)
    const imageData = this.canvasElement.toDataURL('image/jpeg', 0.8)

    // Analyze frame
    const analysis = await this.performImageAnalysis(imageData)

    // Update UI and glasses
    this.displayResults(analysis)
    this.sendToGlasses(analysis)

    this.updateStatus(`Streaming: ${analysis.scene} - ${analysis.confidence.toFixed(0)}% confidence`)
  }

  private async analyzeScene() {
    if (!this.videoElement || !this.canvasElement) return
    
    this.updateStatus('Analyzing scene...')
    
    // Capture frame
    this.canvasElement.width = this.videoElement.videoWidth
    this.canvasElement.height = this.videoElement.videoHeight
    const ctx = this.canvasElement.getContext('2d')
    if (!ctx) return
    
    ctx.drawImage(this.videoElement, 0, 0)
    const imageData = this.canvasElement.toDataURL('image/jpeg', 0.8)
    
    // Analyze image (simulated for demo - would use AI service in production)
    const analysis = await this.performImageAnalysis(imageData)
    
    this.displayResults(analysis)
    this.sendToGlasses(analysis)
    
    this.updateStatus('Analysis complete.')
  }

  private async performImageAnalysis(imageData: string): Promise<ARAnalysis> {
    try {
      // Call LM Studio API (OpenAI-compatible)
      const headers: { [key: string]: string } = {
        'Content-Type': 'application/json',
      }

      if (this.lmStudioConfig.useApiKey && this.lmStudioConfig.apiKey) {
        headers['Authorization'] = `Bearer ${this.lmStudioConfig.apiKey}`
      }

      const response = await fetch(`${this.lmStudioConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          model: this.lmStudioConfig.model,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Analyze this image and provide: 1) Scene description (max 3 words), 2) List of main objects visible (max 5 items), 3) Confidence score (0-1). Return in JSON format: {"scene": "...", "objects": [...], "confidence": ...}'
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageData
                  }
                }
              ]
            }
          ],
          max_tokens: this.lmStudioConfig.maxTokens,
          temperature: this.lmStudioConfig.temperature
        })
      })

      if (!response.ok) {
        throw new Error(`LM Studio API error: ${response.status}`)
      }

      const data = await response.json()
      const content = data.choices[0].message.content

      // Parse the AI response
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        return {
          scene: parsed.scene || 'unknown',
          objects: parsed.objects || [],
          confidence: parsed.confidence || 0.5
        }
      }

      // Fallback if JSON parsing fails
      return {
        scene: 'unknown',
        objects: [],
        confidence: 0.5
      }
    } catch (error) {
      console.error('Error calling LM Studio:', error)
      // Fallback to mock data if API fails
      return {
        objects: ['desk', 'computer', 'coffee mug', 'notebook'],
        scene: 'office workspace (fallback)',
        confidence: 0.5
      }
    }
  }

  private displayResults(analysis: ARAnalysis) {
    const resultsDiv = document.querySelector<HTMLDivElement>('#results')!
    resultsDiv.innerHTML = `
      <div class="result-item">
        <strong>Scene:</strong> ${analysis.scene}
      </div>
      <div class="result-item">
        <strong>Objects detected:</strong>
        <ul>
          ${analysis.objects.map(obj => `<li>${obj}</li>`).join('')}
        </ul>
      </div>
      <div class="result-item">
        <strong>Confidence:</strong> ${(analysis.confidence * 100).toFixed(1)}%
      </div>
    `
  }

  private async sendToGlasses(analysis: ARAnalysis) {
    if (!this.bridge) {
      console.log('Bridge not available - skipping glasses display')
      return
    }

    try {
      // Create text content for glasses
      const content = this.formatForGlasses(analysis)
      
      const textContainer = new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 2,
        borderColor: 5,
        paddingLength: 8,
        containerID: 1,
        containerName: 'main',
        content: content,
        isEventCapture: 1,
      })

      const result = await this.bridge.createStartUpPageContainer(1, [textContainer])
      
      if (result === 0) {
        console.log('Successfully sent to glasses')
        this.updateGlassesPreview(content)
      } else {
        console.error('Failed to send to glasses, result:', result)
      }
    } catch (error) {
      console.error('Error sending to glasses:', error)
    }
  }

  private formatForGlasses(analysis: ARAnalysis): string {
    // Format analysis for small 576x288 display
    // Max ~400-500 characters
    let content = `━ SCENE ANALYSIS ━\n\n`
    content += `Scene: ${analysis.scene}\n\n`
    content += `Objects:\n`
    analysis.objects.slice(0, 4).forEach(obj => {
      content += `• ${obj}\n`
    })
    content += `\nConf: ${(analysis.confidence * 100).toFixed(0)}%\n`
    content += `━ SCROLL FOR MORE ━`
    
    return content
  }

  private updateGlassesPreview(content: string) {
    const preview = document.querySelector<HTMLDivElement>('#glassesDisplay')!
    preview.innerHTML = `<pre>${content}</pre>`
  }

  private updateStatus(message: string) {
    const statusElement = document.querySelector<HTMLParagraphElement>('#status')!
    statusElement.textContent = message
  }

  private saveConfig() {
    const ip = document.querySelector<HTMLInputElement>('#lmStudioIp')!.value
    const port = document.querySelector<HTMLInputElement>('#lmStudioPort')!.value
    const model = document.querySelector<HTMLInputElement>('#lmStudioModel')!.value
    const useApiKey = document.querySelector<HTMLInputElement>('#useApiKey')!.checked
    const apiKey = document.querySelector<HTMLInputElement>('#apiKey')!.value

    this.lmStudioConfig = {
      baseUrl: `http://${ip}:${port}/v1`,
      model: model,
      maxTokens: 500,
      temperature: 0.7,
      useApiKey: useApiKey,
      apiKey: useApiKey ? apiKey : undefined
    }

    localStorage.setItem('lmStudioConfig', JSON.stringify(this.lmStudioConfig))
    this.updateStatus('Configuration saved.')
  }

  private loadConfig() {
    const saved = localStorage.getItem('lmStudioConfig')
    if (saved) {
      try {
        const config = JSON.parse(saved)
        this.lmStudioConfig = config

        // Update UI
        const url = new URL(config.baseUrl)
        document.querySelector<HTMLInputElement>('#lmStudioIp')!.value = url.hostname
        document.querySelector<HTMLInputElement>('#lmStudioPort')!.value = url.port || '1234'
        document.querySelector<HTMLInputElement>('#lmStudioModel')!.value = config.model
        document.querySelector<HTMLInputElement>('#useApiKey')!.checked = config.useApiKey || false
        document.querySelector<HTMLInputElement>('#apiKey')!.value = config.apiKey || ''

        this.updateStatus('Configuration loaded from storage.')
      } catch (error) {
        console.error('Error loading config:', error)
      }
    }
  }

  private async startGlassesAudio() {
    if (!this.bridge) {
      this.updateVoiceStatus('Glasses not connected')
      return
    }

    try {
      await this.bridge.audioControl(true)
      this.isAudioCapturing = true
      document.querySelector<HTMLButtonElement>('#startVoice')!.disabled = true
      document.querySelector<HTMLButtonElement>('#stopVoice')!.disabled = false
      this.updateVoiceStatus('Glasses transcription active... Speak now')
    } catch (error) {
      console.error('Error starting glasses audio:', error)
      this.updateVoiceStatus('Error starting glasses audio')
    }
  }

  private async stopGlassesAudio() {
    if (!this.bridge) return

    try {
      await this.bridge.audioControl(false)
      this.isAudioCapturing = false
      document.querySelector<HTMLButtonElement>('#startVoice')!.disabled = false
      document.querySelector<HTMLButtonElement>('#stopVoice')!.disabled = true
      this.updateVoiceStatus('Glasses transcription stopped')
    } catch (error) {
      console.error('Error stopping glasses audio:', error)
      this.updateVoiceStatus('Error stopping glasses audio')
    }
  }

  private handleGlassesAudio(audioEvent: any) {
    // Glasses provide transcribed text directly
    if (audioEvent.transcript) {
      this.addChatMessage('user', audioEvent.transcript)
      this.sendToAI(audioEvent.transcript)
      this.updateVoiceStatus('Transcription received')
    }
  }

  private async sendTextMessage() {
    const input = document.querySelector<HTMLInputElement>('#textInput')!
    const text = input.value.trim()
    if (!text) return

    input.value = ''
    this.addChatMessage('user', text)
    await this.sendToAI(text)
  }

  private addChatMessage(role: string, content: string) {
    this.chatHistory.push({ role, content })
    this.updateChatDisplay()
  }

  private updateChatDisplay() {
    const chatDiv = document.querySelector<HTMLDivElement>('#chatHistory')!
    if (this.chatHistory.length === 0) {
      chatDiv.innerHTML = '<p class="chat-placeholder">Chat history will appear here...</p>'
      return
    }

    chatDiv.innerHTML = this.chatHistory.map(msg => `
      <div class="chat-message ${msg.role}">
        <strong>${msg.role === 'user' ? 'You' : 'AI'}:</strong>
        <span>${msg.content}</span>
      </div>
    `).join('')

    chatDiv.scrollTop = chatDiv.scrollHeight
  }

  private updateVoiceStatus(message: string) {
    const statusElement = document.querySelector<HTMLParagraphElement>('#voiceStatus')!
    statusElement.textContent = message
  }

  private async sendToAI(message: string) {
    this.updateVoiceStatus('Sending to AI...')

    try {
      const headers: { [key: string]: string } = {
        'Content-Type': 'application/json',
      }

      if (this.lmStudioConfig.useApiKey && this.lmStudioConfig.apiKey) {
        headers['Authorization'] = `Bearer ${this.lmStudioConfig.apiKey}`
      }

      const response = await fetch(`${this.lmStudioConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          model: this.lmStudioConfig.model,
          messages: [
            ...this.chatHistory,
            { role: 'user', content: message }
          ],
          max_tokens: this.lmStudioConfig.maxTokens,
          temperature: this.lmStudioConfig.temperature
        })
      })

      if (!response.ok) {
        throw new Error(`AI API error: ${response.status}`)
      }

      const data = await response.json()
      const aiResponse = data.choices[0].message.content

      this.addChatMessage('assistant', aiResponse)
      this.updateVoiceStatus('Response received')

      // Also send to glasses if connected
      if (this.bridge) {
        const glassesContent = `AI: ${aiResponse.substring(0, 200)}...`
        const textContainer = new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          borderWidth: 2,
          borderColor: 5,
          paddingLength: 8,
          containerID: 1,
          containerName: 'main',
          content: glassesContent,
          isEventCapture: 1,
        })
        await this.bridge.createStartUpPageContainer(1, [textContainer])
      }
    } catch (error) {
      console.error('Error sending to AI:', error)
      this.updateVoiceStatus('Error communicating with AI')
      this.addChatMessage('assistant', 'Sorry, I encountered an error. Please try again.')
    }
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new ARVisionApp()
})
