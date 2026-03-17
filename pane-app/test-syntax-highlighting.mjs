// Test file for comprehensive syntax highlighting
// This should show distinct colors for each token type

// Import statements
import { useState, useEffect, React } from 'react';
import { Engine, Provider } from './engine.js';
import * as utils from '../utils/index.mjs';

// Constants and variables
const API_KEY = 'sk-1234567890';
const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT = 5000;
let currentUser = null;
let sessionData = {};

// Function declarations
export function initializeEngine(config) {
  const engine = new Engine({
    provider: config.provider || 'anthropic',
    apiKey: config.apiKey,
    timeout: config.timeout || DEFAULT_TIMEOUT
  });

  return engine.start();
}

// Class definitions
class BaseProvider {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.options = options;
    this.isInitialized = false;
  }

  async connect() {
    try {
      const connection = await this._createConnection();
      this.isInitialized = true;
      return connection;
    } catch (error) {
      console.error('Connection failed:', error.message);
      throw error;
    }
  }

  _createConnection() {
    // Abstract method - should be implemented by subclasses
    throw new Error('Method not implemented');
  }
}

// React component with JSX
function App() {
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const response = await fetch('/api/data');
        const result = await response.json();
        setData(result);
      } catch (error) {
        console.error('Failed to load data:', error);
      } finally {
        setIsLoading(false);
      }
    }

    loadData();
  }, []);

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>Application Title</h1>
        <nav className="navigation">
          <a href="/home">Home</a>
          <a href="/about">About</a>
          <a href="/contact">Contact</a>
        </nav>
      </header>
      <main className="main-content">
        {isLoading ? (
          <LoadingSpinner />
        ) : (
          <DataDisplay data={data} />
        )}
      </main>
      <footer className="app-footer">
        <p>&copy; 2024 Application Name</p>
      </footer>
    </div>
  );
}

// Utility functions
export const debounce = (func, wait) => {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

// Type definitions (TypeScript-like)
/**
 * @typedef {Object} UserConfig
 * @property {string} apiKey - API key for authentication
 * @property {number} timeout - Request timeout in milliseconds
 * @property {boolean} debug - Enable debug mode
 */

// Complex object
const config = {
  apiKey: process.env.API_KEY || 'default-key',
  endpoints: {
    users: '/api/users',
    projects: '/api/projects',
    settings: '/api/settings'
  },
  features: {
    darkMode: true,
    autoSave: true,
    notifications: {
      email: true,
      push: false
    }
  },
  numbers: [1, 2, 3, 4, 5],
  mixed: ['string', 42, true, null, undefined]
};

// Async/await patterns
async function processData(data) {
  const validated = validateInput(data);
  const transformed = await applyTransformations(validated);
  const result = await saveToDatabase(transformed);
  return result;
}

// Pattern matching
function getStatusColor(status) {
  switch (status) {
    case 'success':
      return '#22c55e';
    case 'warning':
      return '#eab308';
    case 'error':
      return '#ef4444';
    default:
      return '#6b7280';
  }
}

// Regular expressions
const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const phoneRegex = /^\+?[\d\s-()]+$/;

// Comments: This is a block comment explaining the function
// Multiple lines of comments should be styled consistently
function complexCalculation(a, b, options = {}) {
  // Inline comment explaining the calculation
  const { precision = 2, useFloat = false } = options;

  if (useFloat) {
    return parseFloat((a + b).toFixed(precision));
  }

  return Math.round((a + b) * Math.pow(10, precision)) / Math.pow(10, precision);
}

// Export default
export default {
  initializeEngine,
  BaseProvider,
  App,
  debounce,
  processData
};