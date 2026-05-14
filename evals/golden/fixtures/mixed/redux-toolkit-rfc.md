# Redux Toolkit adoption RFC

Proposal: migrate the legacy Redux store to Redux Toolkit incrementally, module by module. `createSlice` everywhere, retire the hand-rolled reducer boilerplate, switch async logic to RTK Query.

Cost estimate: two engineer-weeks per major module. Five modules total.
