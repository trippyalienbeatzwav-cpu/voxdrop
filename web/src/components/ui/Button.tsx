import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Link, type LinkProps } from 'react-router-dom';
import { cx } from '../../lib/format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'kick' | 'outline';
type Size = 'sm' | 'md' | 'lg';

const base =
  'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl font-semibold transition-[background-color,border-color,color,transform,box-shadow] duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50';
const variants: Record<Variant, string> = {
  primary: 'bg-volt text-on-volt hover:bg-[#ffe066] shadow-[0_0_0_1px_rgb(255_212_59/0.3),0_8px_24px_-8px_rgb(255_212_59/0.45)]',
  secondary: 'bg-raised text-fg border border-line hover:border-line-strong hover:bg-overlay',
  outline: 'border border-line-strong text-fg hover:bg-raised',
  ghost: 'text-muted hover:text-fg hover:bg-raised',
  danger: 'bg-danger/12 text-danger border border-danger/30 hover:bg-danger/20',
  kick: 'bg-kick text-black hover:bg-[#6dff3a] shadow-[0_8px_28px_-10px_rgb(83_252_24/0.6)]',
};
const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-4 text-[15px]',
  lg: 'h-13 px-6 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, iconRight, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cx(base, variants[variant], sizes[size], className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
      {iconRight}
    </button>
  );
});

export function ButtonLink({ variant = 'secondary', size = 'md', className, icon, children, ...rest }: LinkProps & { variant?: Variant; size?: Size; icon?: ReactNode }) {
  return (
    <Link className={cx(base, variants[variant], sizes[size], className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}

/** Icon-only button: an accessible name is mandatory. Min 40px hit area. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: 'default' | 'danger' | 'volt'; size?: 'sm' | 'md' }>(
  function IconButton({ label, tone = 'default', size = 'md', className, children, type = 'button', ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        className={cx(
          'inline-flex shrink-0 items-center justify-center rounded-xl border transition-colors duration-150 active:scale-95 disabled:opacity-40 disabled:pointer-events-none',
          size === 'sm' ? 'size-9' : 'size-10',
          tone === 'danger' && 'border-transparent text-muted hover:border-danger/30 hover:bg-danger/10 hover:text-danger',
          tone === 'volt' && 'border-volt/30 bg-volt/10 text-volt hover:bg-volt/20',
          tone === 'default' && 'border-transparent text-muted hover:border-line hover:bg-raised hover:text-fg',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
