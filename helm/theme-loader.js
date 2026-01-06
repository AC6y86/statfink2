// Theme loader - fetches theme from league settings and applies it
(async function loadTheme() {
    try {
        const response = await fetch('/api/league/settings');
        const data = await response.json();
        if (data.success && data.data && data.data.theme) {
            const theme = data.data.theme;
            document.documentElement.setAttribute('data-theme', theme);

            // Add Christmas decorations when theme is active
            if (theme === 'christmas') {
                // Wait for DOM to be ready
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', addChristmasDecorations);
                } else {
                    addChristmasDecorations();
                }
            }
        }
    } catch (e) {
        console.error('Failed to load theme:', e);
    }
})();

function addChristmasDecorations() {
    // Add snowfall container
    const snowfall = document.createElement('div');
    snowfall.className = 'snowfall';
    document.body.appendChild(snowfall);

    // Create snowflakes
    const snowflakeChars = ['❄', '❅', '❆', '✻', '✼', '⁕'];
    for (let i = 0; i < 50; i++) {
        const flake = document.createElement('div');
        flake.className = 'snowflake';
        flake.textContent = snowflakeChars[Math.floor(Math.random() * snowflakeChars.length)];
        flake.style.left = Math.random() * 100 + '%';
        flake.style.animationDuration = (Math.random() * 3 + 5) + 's';
        flake.style.animationDelay = Math.random() * 5 + 's';
        flake.style.fontSize = (Math.random() * 10 + 10) + 'px';
        snowfall.appendChild(flake);
    }

    // Add Santa
    const santa = document.createElement('div');
    santa.className = 'santa-decoration';
    santa.textContent = '🎅';
    santa.title = 'Ho ho ho! Merry Christmas!';
    document.body.appendChild(santa);
}
