import React from 'react';
import Link from 'next/link';

type CTAButtonVariant = 'outline' | 'primary' | 'inverted';

interface CTAButtonProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: CTAButtonVariant;
  iconRight?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  unstyled?: boolean;
}

const SHADOW =
  '0 6.745px 6.745px -3.372px rgba(0, 195, 255, 0.05), 0 13.489px 13.489px -6.745px rgba(0, 195, 255, 0.05), 0 26.979px 26.979px 0 rgba(0, 195, 255, 0.05)';

export default function CTAButton({
  href,
  children,
  variant = 'outline',
  iconRight,
  className,
  style,
  unstyled = false,
  target,
  rel,
  ...rest
}: CTAButtonProps) {
  const base =
    'inline-flex h-8 items-center justify-center rounded-[10px] px-[14px] py-3 text-[14px] font-bold leading-[19.5px] tracking-[-0.14px]';

  let visual: React.CSSProperties = {
    fontFeatureSettings: '"liga" off',
    boxShadow: SHADOW,
    textAlign: 'center',
  };

  if (variant === 'outline') {
    visual = {
      ...visual,
      border: '1px solid #DFF8FF',
      color: '#DFF8FF',
      background: 'transparent',
    };
  } else if (variant === 'primary') {
    visual = { ...visual, background: '#00C3FF', color: '#0E404F' };
  } else if (variant === 'inverted') {
    visual = { ...visual, background: '#FFFFFF', color: '#0E404F' };
  }

  const combinedClassName = `${base} ${className ?? ''}`;
  const combinedStyle = unstyled ? { ...style } : { ...visual, ...style };

  // Use Next.js Link for internal routes (SPA navigation)
  const isInternalRoute = href.startsWith('/') && !href.startsWith('//');

  if (isInternalRoute) {
    return (
      <Link href={href} className={combinedClassName} style={combinedStyle} {...rest}>
        {children}
        {iconRight ? <span className="ml-1 flex items-center">{iconRight}</span> : null}
      </Link>
    );
  }

  return (
    <a
      href={href}
      className={combinedClassName}
      style={combinedStyle}
      target={target}
      rel={rel}
      {...rest}
    >
      {children}
      {iconRight ? <span className="ml-1 flex items-center">{iconRight}</span> : null}
    </a>
  );
}
