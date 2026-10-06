// login.js - handles the Log in / Create account forms on login.html
const errorBox = document.getElementById('authError');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const tabLogin = document.getElementById('tabLogin');
const tabSignup = document.getElementById('tabSignup');

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.style.display = msg ? 'block' : 'none';
}

function showTab(which) {
  const isLogin = which === 'login';
  loginForm.style.display = isLogin ? 'block' : 'none';
  signupForm.style.display = isLogin ? 'none' : 'block';
  tabLogin.classList.toggle('active', isLogin);
  tabSignup.classList.toggle('active', !isLogin);
  showError('');
}
tabLogin.onclick = () => showTab('login');
tabSignup.onclick = () => showTab('signup');

async function post(url, body, button) {
  showError('');
  button.disabled = true;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || 'Something went wrong.');
    window.location.replace('index.html');
  } catch (err) {
    showError(err instanceof TypeError
      ? "Can't reach the UniFlow server. Run `npm start` and open http://localhost:3000"
      : err.message);
    button.disabled = false;
  }
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  post('/api/auth/login', {
    email: document.getElementById('loginEmail').value,
    password: document.getElementById('loginPassword').value
  }, loginForm.querySelector('button[type=submit]'));
});

signupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  post('/api/auth/register', {
    name: document.getElementById('signupName').value,
    program: document.getElementById('signupProgram').value,
    email: document.getElementById('signupEmail').value,
    password: document.getElementById('signupPassword').value
  }, signupForm.querySelector('button[type=submit]'));
});

// Already logged in? Skip straight to the dashboard.
fetch('/api/auth/me', { credentials: 'same-origin' })
  .then(r => { if (r.ok) window.location.replace('index.html'); })
  .catch(() => {});
