import type { Meta, StoryObj } from '@storybook/react-vite';
import ChatSkeleton from './ChatSkeleton';

const meta: Meta<typeof ChatSkeleton> = {
  title: 'UI/ChatSkeleton',
  component: ChatSkeleton,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof ChatSkeleton>;

export const Default: Story = {};
