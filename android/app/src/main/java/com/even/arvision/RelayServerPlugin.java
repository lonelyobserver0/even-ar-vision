package com.even.arvision;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import fi.iki.elonen.NanoHTTPD;

/** Capacitor plugin: start/stop the embedded relay (RelayHttpd) from the web layer. */
@CapacitorPlugin(name = "RelayServer")
public class RelayServerPlugin extends Plugin {
    private RelayHttpd server;

    @PluginMethod
    public void start(PluginCall call) {
        int port = call.getInt("port", 8787);
        try {
            if (server == null) {
                server = new RelayHttpd(port);
                server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
            }
            JSObject ret = new JSObject();
            ret.put("url", "http://localhost:" + port);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to start relay: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (server != null) {
            server.stop();
            server = null;
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (server != null) {
            server.stop();
            server = null;
        }
    }
}
