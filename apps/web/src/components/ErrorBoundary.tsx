import { Component, type ErrorInfo, type ReactNode } from 'react';
import i18n from '../i18n';
import { reportError } from '../lib/monitor';

/** A screen that crashes shows a way out instead of a blank page, and the error is reported. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error.message, `${error.stack ?? ''}\n--- component ---${info.componentStack ?? ''}`);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="mx-auto max-w-md p-8 text-center" role="alert">
        <p className="mb-4 text-slate-700">{i18n.t('common.crash')}</p>
        <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
          {i18n.t('common.reload')}
        </button>
      </div>
    );
  }
}
