/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          deep: '#f3f5f9',
          panel: '#ffffff',
          card: '#ffffff',
          input: '#f8fafc',
        },
        border: {
          DEFAULT: '#e2e6ee',
          focus: '#4f46e5',
          success: '#10b981',
        },
        accent: {
          DEFAULT: '#4f46e5',
          hover: '#4338ca',
          soft: '#eef2ff',
        },
        success: '#059669',
        danger: '#dc2626',
        text: {
          heading: '#111827',
          main: '#26303e',
          muted: '#5b6b81',
        },
      },
      fontFamily: {
        display: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
      },
      fontWeight: {
        extrabold: '800',
        black: '900',
      },
      borderRadius: {
        none: '0',
      },
      animation: {
        'scanline': 'scanline 8s linear infinite',
        'noise': 'noise 0.5s steps(2) infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'slide-up': 'slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fade-in 0.3s ease-out',
      },
      keyframes: {
        scanline: {
          '0%': { transform: 'translateY(0)' },
          '100%': { transform: 'translateY(100vh)' },
        },
        noise: {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '10%': { transform: 'translate(-5%, -5%)' },
          '20%': { transform: 'translate(10%, 5%)' },
          '30%': { transform: 'translate(-5%, 10%)' },
          '40%': { transform: 'translate(15%, -5%)' },
          '50%': { transform: 'translate(-5%, 15%)' },
          '60%': { transform: 'translate(10%, 5%)' },
          '70%': { transform: 'translate(-10%, -10%)' },
          '80%': { transform: 'translate(5%, 10%)' },
          '90%': { transform: 'translate(-5%, 5%)' },
        },
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 5px rgba(255, 193, 7, 0.3)' },
          '50%': { boxShadow: '0 0 20px rgba(255, 193, 7, 0.6)' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}
