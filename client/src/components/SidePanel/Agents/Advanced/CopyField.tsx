import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button, TooltipAnchor, labelVariants, useToastContext } from '@librechat/client';
import { useLocalize } from '~/hooks';

interface CopyFieldProps {
  label: string;
  value: string;
  copyLabel: string;
  copiedMessage: string;
}

/** A labeled value that copies itself to the clipboard, with a success or error toast. */
export default function CopyField({ label, value, copyLabel, copiedMessage }: CopyFieldProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      showToast({ message: copiedMessage, status: 'success' });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast({ message: localize('com_ui_error'), status: 'error' });
    }
  };

  return (
    <div className="flex items-center justify-between gap-2">
      <span className={labelVariants({ variant: 'section' })}>{label}</span>
      <TooltipAnchor
        description={value}
        render={
          <Button
            variant="ghost"
            onClick={handleCopy}
            aria-label={copyLabel}
            className="h-auto gap-1.5 rounded-lg px-2 py-1 text-text-secondary hover:bg-surface-secondary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
          >
            <code className="max-w-[150px] truncate font-mono text-xs">{value}</code>
            <span className="t-icon-swap" data-state={copied ? 'b' : 'a'} aria-hidden="true">
              <span className="t-icon" data-icon="a">
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="t-icon" data-icon="b">
                <Check className="h-3.5 w-3.5 text-status-success" aria-hidden="true" />
              </span>
            </span>
          </Button>
        }
      />
    </div>
  );
}
