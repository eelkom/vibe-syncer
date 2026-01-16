import { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-col items-center justify-center p-8">
          <h2 className="mb-2 text-lg font-bold text-red-600">
            Something went wrong.
          </h2>
          <p className="mb-4 text-gray-500">
            Please try refreshing the page or go back to the home screen.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => window.location.reload()}
              className="rounded bg-blue-600 px-4 py-2 text-white"
            >
              Refresh
            </button>
            <button
              onClick={() => (window.location.href = '/')}
              className="rounded bg-gray-300 px-4 py-2 text-gray-800"
            >
              Home
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
