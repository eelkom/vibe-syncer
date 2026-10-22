import { Component, type ReactNode } from 'react';
import Button from './ui/Button';

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
        <div className="flex flex-col items-center justify-center">
          <h2 className="mb-2 text-lg font-bold text-red-600">
            Something went wrong.
          </h2>
          <p className="mb-4 text-gray-500">
            Please try refreshing the page or go back to the home screen.
          </p>
          <div className="flex gap-2">
            <Button variant="success" onClick={() => window.location.reload()}>
              Refresh
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
