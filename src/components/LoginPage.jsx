import { lazy, Suspense, useEffect, useState } from 'react'
import { useAuth, supabase } from '../AuthContext'
import { useNavigate } from 'react-router-dom'

const Spline = lazy(() => import('@splinetool/react-spline'))
// const SCENE_URL = 'https://prod.spline.design/BlxkFkzk0Djl1PYU/scene.splinecode'
// const SCENE_URL = 'https://prod.spline.design/NzzIe5VMGb-XFzW3/scene.splinecode'
const SCENE_URL = 'https://prod.spline.design/Z6XqB-URL2tfbyrw/scene.splinecode'

// Loads the two typefaces used on this page. Move this into your global
// index.html <head> if you'd rather not inject it at runtime.
function useFonts() {
  useEffect(() => {
    if (document.getElementById('lp-fonts')) return
    const link = document.createElement('link')
    link.id = 'lp-fonts'
    link.rel = 'stylesheet'
    link.href =
      'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=IBM+Plex+Sans:wght@400;500;600&display=swap'
    document.head.appendChild(link)
  }, [])
}

const font = {
  display: { fontFamily: "'Fraunces', serif" },
  body: { fontFamily: "'IBM Plex Sans', sans-serif" },
}

// Colors for content sitting over the dark Spline scene.
const hero = {
  heading: '#F6F4EF',
  accent: '#6FCF9E',
  body: '#B9BCC2',
  headerBorder: 'rgba(246,244,239,0.14)',
  buttonBorder: 'rgba(246,244,239,0.35)',
}

export default function LoginPage() {
  useFonts()

  const { session, loading: authLoading, signInWithOtp, signOut } = useAuth()
  const navigate = useNavigate()

  const [sceneLoaded, setSceneLoaded] = useState(false)
  const [showLoginModal, setShowLoginModal] = useState(false)
  const [loginLoading, setLoginLoading] = useState(false)
  const [email, setEmail] = useState('')

  const params = new URLSearchParams(window.location.search)
  const hasTokenHash = params.get('token_hash')
  const [verifying, setVerifying] = useState(!!hasTokenHash)
  const [authError, setAuthError] = useState(null)
  const [authSuccess, setAuthSuccess] = useState(false)

  useEffect(() => {
    if (session) {
      console.log('Logged in! Session details:', session)
    }

    const token_hash = params.get('token_hash')
    const type = params.get('type')

    if (token_hash) {
      supabase.auth
        .verifyOtp({ token_hash, type: type || 'email' })
        .then(({ error }) => {
          if (error) {
            setAuthError(error.message)
          } else {
            setAuthSuccess(true)
            window.history.replaceState({}, document.title, '/')
          }
          setVerifying(false)
        })
    }
  }, [])

  const handleLogin = async (event) => {
    event.preventDefault()
    setLoginLoading(true)
    const { error } = await signInWithOtp(email)
    if (error) {
      alert(error.error_description || error.message)
    } else {
      alert('Check your email for the login link!')
    }
    setLoginLoading(false)
  }

  const handleLogout = async () => {
    await signOut()
  }

  const StatusOverlay = ({ children }) => (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ ...font.body, backgroundColor: 'rgba(251,250,247,0.97)' }}
    >
      <div
        className="w-full max-w-sm p-8"
        style={{ backgroundColor: '#FBFAF7', border: '1px solid #E4E2DC', borderRadius: '4px' }}
      >
        {children}
      </div>
    </div>
  )

  if (verifying) {
    return (
      <StatusOverlay>
        <div className="flex flex-col items-center text-center gap-4">
          <div className="relative h-10 w-10">
            <div className="absolute inset-0 rounded-full border-2" style={{ borderColor: '#E4E2DC' }} />
            <div
              className="absolute inset-0 animate-spin rounded-full border-2 border-transparent"
              style={{ borderTopColor: '#14161F' }}
            />
          </div>
          <h1 className="text-lg font-medium" style={{ ...font.display, color: '#14161F' }}>
            Authentication
          </h1>
          <p className="text-sm" style={{ ...font.body, color: '#6B6F76' }}>
            Confirming your magic link...
          </p>
        </div>
      </StatusOverlay>
    )
  }

  if (authError) {
    return (
      <StatusOverlay>
        <div className="flex flex-col items-center text-center gap-4">
          <div
            className="h-10 w-10 flex items-center justify-center text-lg"
            style={{ borderRadius: '4px', backgroundColor: '#FBEBE9', color: '#B3453D' }}
          >
            &#10007;
          </div>
          <h1 className="text-lg font-medium" style={{ ...font.display, color: '#14161F' }}>
            Authentication failed
          </h1>
          <p className="text-sm" style={{ ...font.body, color: '#6B6F76' }}>
            {authError}
          </p>
          <button
            onClick={() => {
              setAuthError(null)
              window.history.replaceState({}, document.title, '/')
            }}
            className="mt-2 w-full text-sm font-medium py-2.5 transition-colors"
            style={{ ...font.body, backgroundColor: '#14161F', color: '#FBFAF7', borderRadius: '4px' }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#2A2D38')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#14161F')}
          >
            Return to login
          </button>
        </div>
      </StatusOverlay>
    )
  }

  if (authSuccess && authLoading) {
    return (
      <StatusOverlay>
        <div className="flex flex-col items-center text-center gap-4">
          <div
            className="h-10 w-10 flex items-center justify-center text-lg"
            style={{ borderRadius: '4px', backgroundColor: '#E7EFEC', color: '#2F5D50' }}
          >
            &#10003;
          </div>
          <h1 className="text-lg font-medium" style={{ ...font.display, color: '#14161F' }}>
            Authentication successful
          </h1>
          <p className="text-sm" style={{ ...font.body, color: '#6B6F76' }}>
            Loading your account...
          </p>
        </div>
      </StatusOverlay>
    )
  }

  if (session) {
    navigate('/Dashboard')
    return null
  }

  return (
    <main className="relative min-h-screen overflow-hidden" style={{ backgroundColor: '#0B0B0E' }}>
      {!sceneLoaded && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6"
          style={{ backgroundColor: '#0B0B0E' }}
        >
          <div className="relative h-16 w-16">
            <div className="absolute inset-0 rounded-full border-2" style={{ borderColor: 'rgba(246,244,239,0.15)' }} />
            <div
              className="absolute inset-0 animate-spin rounded-full border-2 border-transparent"
              style={{ borderTopColor: hero.heading }}
            />
          </div>
          <p className="text-sm font-medium tracking-wide" style={{ ...font.body, color: hero.heading }}>
            Loading...
          </p>
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 z-0">
        <Suspense fallback={null}>
          <Spline scene={SCENE_URL} className="spline-canvas h-full w-full" onLoad={() => setSceneLoaded(true)} />
        </Suspense>
      </div>

      <div
        className={`relative z-10 flex min-h-screen flex-col justify-center px-6 py-8 md:px-12 md:py-10 transition-opacity duration-500 ${
          sceneLoaded ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <section className="flex max-w-2xl flex-col gap-6 mt-32">
          <h1
            className="text-4xl leading-[1.1] tracking-tight md:text-6xl lg:text-7xl"
            style={{ ...font.display, fontWeight: 500, color: hero.heading }}
          >
            Your ML expert,
            <br />
            <span style={{ color: hero.accent }}>on demand.</span>
          </h1>
          <p className="max-w-md text-base leading-relaxed md:text-lg" style={{ ...font.body, color: hero.body }}>
            Ask questions, debug models, and design architectures with a chatbot built for machine
            learning.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              onClick={() => setShowLoginModal(true)}
              className="inline-flex items-center justify-center px-6 py-3 text-sm font-medium transition-colors"
              style={{ ...font.body, backgroundColor: hero.heading, color: '#14161F', borderRadius: '4px' }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#D9D6CE')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = hero.heading)}
            >
              Get started
            </button>
          </div>
        </section>
      </div>

      {showLoginModal && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center px-4"
          style={{ backgroundColor: 'rgba(20,22,31,0.45)', backdropFilter: 'blur(4px)' }}
        >
          <div
            className="relative w-full max-w-sm p-8"
            style={{ backgroundColor: '#FBFAF7', border: '1px solid #E4E2DC', borderRadius: '4px' }}
          >
            <button
              onClick={() => setShowLoginModal(false)}
              className="absolute right-4 top-4 text-sm transition-colors"
              style={{ color: '#9A9DA4' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#14161F')}
              onMouseLeave={(e) => (e.currentTarget.style.color = '#9A9DA4')}
              aria-label="Close"
            >
              &#10005;
            </button>
            <div className="flex flex-col gap-6">
              <div className="text-center">
                <h1 className="text-xl" style={{ ...font.display, fontWeight: 500, color: '#14161F' }}>
                  Sign in
                </h1>
                <p className="mt-1 text-sm" style={{ ...font.body, color: '#6B6F76' }}>
                  We'll email you a magic link, no password needed.
                </p>
              </div>
              <form onSubmit={handleLogin} className="flex flex-col gap-4">
                <div>
                  <label htmlFor="email" className="sr-only">
                    Email address
                  </label>
                  <input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    required
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm placeholder-gray-400 focus:outline-none transition"
                    style={{
                      ...font.body,
                      color: '#14161F',
                      border: '1px solid #D8D5CD',
                      borderRadius: '4px',
                      backgroundColor: '#FFFFFF',
                    }}
                    onFocus={(e) => (e.currentTarget.style.borderColor = '#14161F')}
                    onBlur={(e) => (e.currentTarget.style.borderColor = '#D8D5CD')}
                  />
                </div>
                <button
                  disabled={loginLoading}
                  className="w-full text-sm font-medium py-2.5 transition-colors flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                  style={{ ...font.body, backgroundColor: '#14161F', color: '#FBFAF7', borderRadius: '4px' }}
                  onMouseEnter={(e) => !loginLoading && (e.currentTarget.style.backgroundColor = '#2A2D38')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#14161F')}
                >
                  {loginLoading ? (
                    <>
                      <span className="h-4 w-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                      <span>Sending...</span>
                    </>
                  ) : (
                    <span>Send magic link</span>
                  )}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}