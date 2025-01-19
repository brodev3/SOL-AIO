# SOL-AIO

<p>
      <img src="https://i.ibb.co/3sHQCSp/av.jpg" >
</p>

<p >
   <img src="https://img.shields.io/badge/build-v_1.0-brightgreen?label=Version" alt="Version">
</p>


## About

SOL-AIO is a tool for automating operations with the Solana network. It allows you to manage multiple wallets and perform various operations with SOL and SPL tokens.


## Features
- **Multiple Senders and Receivers**: Supports loading multiple wallets and receiver addresses from CSV files.
- **Support for SOL and SPL Tokens**: Allows sending both SOL and SPL tokens.
- **Token Collection and Distribution**: Ability to collect tokens from different wallets or distribute them to various wallets (in development).- 

 ## Configuration
Settings are located in the `config/config.js` file. Key parameters:

- `RPC_ENDPOINT`: URL of the Solana RPC server.
- `MAX_RETRIES`: Maximum number of attempts for sending transactions.
- `DECRYPT`: Flag to enable decryption of private keys.
- `MESSAGE`: Secret message for decryption.
- `MAX_TIME`: The maximum time (in milliseconds) that will be randomly assigned to delay the execution of token transfers from each wallet. All accounts will be triggered within this random delay. For example, if MAXTIME is set to 5000, the transfer can occur anytime between 1 second and 5 seconds (1000-5000 milliseconds).

 ## How to Start

1. Node JS
2. Clone the repository to your disk
3. Configure `config/config.js` with the appropriate parameters
4. Add wallet information to `input/w.csv` and `input/receivers.csv`
5. Launch the console (for example, Windows PowerShell)
6. Specify the working directory where you have uploaded the repository in the console using the CD command
    ```
    cd C:\Program Files\brothers
    ```
7. Install packages
   
    ```
    npm install
    ```
8. Run the software, and it will transfer tokens from the specified wallets to the respective addresses. All accounts will start transferring after a random delay, determined between 1 second and the value specified in MAXTIME.
    ```
    node index
    ```





## License

Project **brodev3**/SOL-AIO is distributed under the MIT license.
