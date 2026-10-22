import type { Meta, StoryObj } from '@storybook/react-vite';
import Loading from './Loading';

const meta: Meta<typeof Loading> = {
  title: 'UI/Loading',
  component: Loading,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof Loading>;

export const Default: Story = {};

export const Small: Story = {
  args: {
    size: 64,
  },
};
