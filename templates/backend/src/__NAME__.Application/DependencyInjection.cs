using __NAME__.Application.Status;
using Microsoft.Extensions.DependencyInjection;

namespace __NAME__.Application;

public static class DependencyInjection
{
    /// <summary>Registers every use case. Add each new one here.</summary>
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddScoped<GetStatus>();
        return services;
    }
}
