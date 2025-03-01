import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  // 这里可以添加自定义的props
}

const Input = ({ className = "", ...props }: InputProps) => {
  return <input autoComplete="off" className={className} {...props} />;
};

export default Input;
