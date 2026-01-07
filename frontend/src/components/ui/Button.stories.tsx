import type { Meta, StoryObj } from '@storybook/react';
import Button from './Button';

const meta: Meta<typeof Button> = {
  title: 'UI/Button',
  component: Button,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['primary', 'secondary', 'danger'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {
  args: {
    variant: 'primary',
    children: 'Play Music',
  },
};

export const Secondary: Story = {
  args: {
    variant: 'secondary',
    children: 'pause',
  },
};

export const Danger: Story = {
  args: {
    variant: 'danger',
    children: 'Delete Room',
  },
};
