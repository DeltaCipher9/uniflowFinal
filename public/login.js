const errorBox = document.getElementById('authError');
const successBox = document.getElementById('authSuccess');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const forgotForm = document.getElementById('forgotForm');
const resetForm = document.getElementById('resetForm');
const tabs = document.getElementById('authTabs');
const tabLogin = document.getElementById('tabLogin');
const tabSignup = document.getElementById('tabSignup');
const resetToken = new URLSearchParams(location.search).get('reset');

function showError(msg) { errorBox.textContent = msg; errorBox.style.display = msg ? 'block' : 'none'; }
function showSuccess(msg) { successBox.textContent = msg; successBox.style.display = msg ? 'block' : 'none'; }
function showOnly(form) {
  [loginForm, signupForm, forgotForm, resetForm].forEach(f => f.style.display = f === form ? 'block' : 'none');
  tabs.style.display = form === resetForm || form === forgotForm ? 'none' : 'grid';
  showError(''); showSuccess('');
}
function showTab(which) {
  const isLogin = which === 'login';
  showOnly(isLogin ? loginForm : signupForm);
  tabLogin.classList.toggle('active', isLogin);
  tabSignup.classList.toggle('active', !isLogin);
}

tabLogin.onclick = () => showTab('login');
tabSignup.onclick = () => showTab('signup');
document.getElementById('forgotLink').onclick = () => {
  document.getElementById('forgotEmail').value = document.getElementById('loginEmail').value;
  showOnly(forgotForm);
};
document.getElementById('backToLogin').onclick = () => showOnly(loginForm);
document.getElementById('resetBackLogin').onclick = () => { history.replaceState({}, '', 'login.html'); showOnly(loginForm); };

document.querySelectorAll('.password-toggle').forEach(btn => btn.addEventListener('click', () => {
  const input = document.getElementById(btn.dataset.target);
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  btn.textContent = visible ? 'Show' : 'Hide';
  btn.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
}));

async function post(url, body, button, redirect = true) {
  showError(''); showSuccess(''); button.disabled = true;
  try {
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body:JSON.stringify(body) });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || 'Something went wrong.');
    if (redirect) window.location.replace('index.html');
    return payload;
  } catch (err) {
    showError(err instanceof TypeError ? "Can't reach the UniFlow server. Run `npm start` and open http://localhost:3000" : err.message);
    throw err;
  } finally { button.disabled = false; }
}

loginForm.addEventListener('submit', e => {
  e.preventDefault();
  post('/api/auth/login', { email:loginEmail.value, password:loginPassword.value }, loginForm.querySelector('button[type=submit]'));
});
signupForm.addEventListener('submit', e => {
  e.preventDefault();
  post('/api/auth/register', { name:signupName.value, program:signupProgram.value, email:signupEmail.value, password:signupPassword.value }, signupForm.querySelector('button[type=submit]'));
});
forgotForm.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = forgotForm.querySelector('button[type=submit]');
  try {
    const payload = await post('/api/auth/forgot-password', { email:forgotEmail.value }, btn, false);
    showSuccess(payload.message || 'If an account exists for that email, a reset link has been sent.');
  } catch (_) {}
});
resetForm.addEventListener('submit', async e => {
  e.preventDefault();
  if (resetPassword.value !== resetPasswordConfirm.value) return showError('The passwords do not match.');
  const btn = resetForm.querySelector('button[type=submit]');
  try {
    await post('/api/auth/reset-password', { token:resetToken, password:resetPassword.value }, btn, false);
    history.replaceState({}, '', 'login.html');
    showOnly(loginForm);
    showSuccess('Password changed successfully. You can now log in with your new password.');
  } catch (_) {}
});

if (resetToken) {
  showOnly(resetForm);
} else {
  fetch('/api/auth/me', { credentials:'same-origin' }).then(r => { if (r.ok) window.location.replace('index.html'); }).catch(() => {});
}
