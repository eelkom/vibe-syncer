import type { Meta, StoryObj } from '@storybook/react-vite';
import TextField from './TextField';

const meta: Meta<typeof TextField> = {
  title: 'UI/TextField',
  component: TextField,
  tags: ['autodocs'],
  args: {
    id: 'roomName',
    label: 'Room Name',
    placeholder: 'Enter room name...',
  },
};

export default meta;
type Story = StoryObj<typeof TextField>;

export const Default: Story = {};

export const Disabled: Story = {
  args: {
    disabled: true,
    defaultValue: 'My Room',
  },
};
