# edge-to-edge — coding profile for the supplied Android template

Apply system-bar and IME safety using the supplied SDK 35 / Compose BOM 2025.05.01 dependencies. Implement edge-to-edge intentionally with enableEdgeToEdge before setContent, readable status/navigation bar icons, and correct safe areas on every screen. Keep background art drawing behind bars while interactive content remains reachable.

Use Scaffold padding once. Consume applied padding with consumeWindowInsets(innerPadding) before adding any remaining imePadding. Do not stack parent safe-area padding and child Scaffold/IME padding that account for the same inset. The launcher already uses adjustResize: preserve it. Do not use adjustPan or add unsupported WindowInsetsRulers/fitInside APIs from newer Compose versions. Keep form fields and Save/Cancel accessible with the keyboard visible in portrait and landscape; use a bounded viewport and one scroll owner. Match system icon brightness to the actual background.
