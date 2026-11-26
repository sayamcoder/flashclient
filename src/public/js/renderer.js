document.addEventListener('DOMContentLoaded', () => {
  // Titlebar controls
  const minBtn = document.getElementById('min-btn');
  const maxBtn = document.getElementById('max-btn');
  const closeBtn = document.getElementById('close-btn');

  if (window.electronAPI) {
    minBtn?.addEventListener('click', () => window.electronAPI.minimize());
    maxBtn?.addEventListener('click', () => window.electronAPI.maximize());
    closeBtn?.addEventListener('click', () => window.electronAPI.close());
  }

  // Microsoft Login Button State Handler
  const loginBtn = document.getElementById('microsoft-login-btn');
  const loginLabel = document.getElementById('login-label');

  loginBtn?.addEventListener('click', async () => {
    if (!window.electronAPI) return;

    // Show loading spinner
    loginBtn.disabled = true;
    loginBtn.classList.add('opacity-85', 'cursor-not-allowed');
    loginLabel.innerHTML = `
      <div class="flex items-center space-x-2">
        <svg class="animate-spin h-3.5 w-3.5 text-black" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        <span>Connecting to Microsoft...</span>
      </div>
    `;

    try {
      const res = await window.electronAPI.loginWithMicrosoft();
      if (res && res.success) {
        loginLabel.innerHTML = `Welcome, <strong>${res.username}</strong>!`;
        loginBtn.classList.remove('bg-white', 'hover:bg-gray-100');
        loginBtn.classList.add('bg-emerald-400', 'text-black');
      }
    } catch (err) {
      console.error('Login failed', err);
      loginLabel.innerHTML = 'Log in with <strong>Microsoft</strong>';
      loginBtn.disabled = false;
      loginBtn.classList.remove('opacity-85', 'cursor-not-allowed');
    }
  });
document.addEventListener('DOMContentLoaded', () => {
  // Window Minimize & Close
  const minBtn = document.getElementById('min-btn');
  const closeBtn = document.getElementById('close-btn');

  if (window.electronAPI) {
    minBtn?.addEventListener('click', () => window.electronAPI.minimize());
    closeBtn?.addEventListener('click', () => window.electronAPI.close());
  }

  // --- CRACKED ACCOUNT MODAL ---
  const crackedModal = document.getElementById('cracked-modal');
  const openCrackedBtn = document.getElementById('cracked-open-btn');
  const closeCrackedBtn = document.getElementById('cracked-close-btn');
  const cancelCrackedBtn = document.getElementById('cracked-cancel-btn');
  const crackedInput = document.getElementById('cracked-input');
  const crackedForm = document.getElementById('cracked-form');
  const crackedError = document.getElementById('cracked-error');
  const avatarPreview = document.getElementById('avatar-preview');

  function openModal() {
    if (!crackedModal) return;
    crackedModal.style.display = 'flex';
    setTimeout(() => crackedInput?.focus(), 50);
  }

  function closeModal() {
    if (!crackedModal) return;
    crackedModal.style.display = 'none';
    if (crackedError) crackedError.classList.add('hidden');
  }

  // Open Modal on Cracked button click
  openCrackedBtn?.addEventListener('click', openModal);
  closeCrackedBtn?.addEventListener('click', closeModal);
  cancelCrackedBtn?.addEventListener('click', closeModal);

  // Click outside to close
  crackedModal?.addEventListener('click', (e) => {
    if (e.target === crackedModal) closeModal();
  });

  // Dynamic Avatar Skin Preview while typing
  let debounceTimer;
  crackedInput?.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    const username = e.target.value.trim();

    if (username.length >= 3) {
      debounceTimer = setTimeout(() => {
        avatarPreview.src = `https://mc-heads.net/avatar/${encodeURIComponent(username)}/64`;
      }, 350);
    } else {
      avatarPreview.src = 'https://mc-heads.net/avatar/MHF_Steve/64';
    }
  });

  // Handle Form Submission
  crackedForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = crackedInput.value.trim();
    const usernameRegex = /^[a-zA-Z0-9_]{3,16}$/;

    if (!usernameRegex.test(username)) {
      crackedError.classList.remove('hidden');
      return;
    }

    crackedError.classList.add('hidden');

    if (window.electronAPI?.loginCracked) {
      await window.electronAPI.loginCracked(username);
    }

    // Success State
    openCrackedBtn.innerHTML = `
      <span class="text-emerald-400 font-bold">✓ ${username}</span>
    `;
    openCrackedBtn.classList.add('border-emerald-500/50');
    
    closeModal();
  });

  // --- MICROSOFT LOGIN ---
  const msLoginBtn = document.getElementById('microsoft-login-btn');
  msLoginBtn?.addEventListener('click', async () => {
    if (!window.electronAPI) return;

    msLoginBtn.disabled = true;
    msLoginBtn.innerHTML = `
      <svg class="animate-spin h-4 w-4 text-black mr-2 inline" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
      </svg>
      <span>Connecting...</span>
    `;

    try {
      const res = await window.electronAPI.loginWithMicrosoft();
      if (res?.success) {
        msLoginBtn.innerHTML = `Logged in as <strong>${res.username}</strong>`;
        msLoginBtn.classList.add('bg-emerald-400');
      }
    } catch (err) {
      msLoginBtn.disabled = false;
      msLoginBtn.innerHTML = 'Log in with <strong>Microsoft</strong>';
    }
  });
});
  // Generate Subtle Floating Amethyst Spores / Particles
  const container = document.getElementById('particles-container');
  if (container) {
    const particleCount = 24;
    for (let i = 0; i < particleCount; i++) {
      const particle = document.createElement('div');
      const size = Math.random() * 3 + 2;
      const posX = Math.random() * 100;
      const posY = Math.random() * 100;
      const delay = Math.random() * 5;
      const duration = Math.random() * 6 + 6;

      particle.style.cssText = `
        position: absolute;
        width: ${size}px;
        height: ${size}px;
        background: #f0abfc;
        border-radius: 50%;
        top: ${posY}%;
        left: ${posX}%;
        opacity: ${Math.random() * 0.6 + 0.2};
        filter: drop-shadow(0 0 6px #c084fc);
        animation: floatParticle ${duration}s ease-in-out infinite;
        animation-delay: ${delay}s;
      `;
      container.appendChild(particle);
    }

    // Add keyframe dynamically
    const styleSheet = document.createElement('style');
    styleSheet.textContent = `
      @keyframes floatParticle {
        0%, 100% { transform: translateY(0px) translateX(0px); opacity: 0.2; }
        50% { transform: translateY(-24px) translateX(12px); opacity: 0.8; }
      }
    `;
    document.head.appendChild(styleSheet);
  }
});